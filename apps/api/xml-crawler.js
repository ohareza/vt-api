const { api_data, logger, TEMPLATE, CHANNEL_LIMIT } = require('./consts');
const node_fetch = require('node-fetch');

const fetch = url => node_fetch(url).then(res => res.text());
const baseURL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const re = /<yt:videoId>(.*)<.*\n.*<yt:channelId>(.*)<.*\n.*<title>(.*)<\/title>(?:\n.*){0,10}<published>(.*)</g;

const videoCache = {};

module.exports = main;

async function main() {
  logger.api.xmlCrawler('fetching %d channels to crawl...', CHANNEL_LIMIT);
  logger.db.api_data('fetching %d channels...', CHANNEL_LIMIT);

  const channels = await api_data.channels
    .findAsCursor(
      { 'youtube': { $exists: 1 } },
      { 'youtube': 1, 'from': 1 })
    .sort({ 'crawled_at': 1 })
    .limit(CHANNEL_LIMIT)
    .toArray();

  logger.db.api_data('found %d channels.', channels.length);
  if (!channels.length) {
    return logger.api.xmlCrawler('no channels to fetch.');
  }
  logger.db.api_data('found %d channels to crawl.', channels.length);

  // scrape channel xml feeds
  logger.api.helpers.xmlCrawler('crawling %d channels...', channels.length);
  const updatedData = await Promise.all(channels.map(fetchXML));

  const [updatedChannels, videoCount] = updatedData.reduce(countUpdated);
  updatedChannels
    ? logger.api.xmlCrawler('successfully updated %d videos from %d channels.', updatedChannels, videoCount)
    : logger.api.xmlCrawler('no new videos found.');
}

/**
 * Fetches XML feed from youtube
 *
 * @param   {{youtube: String}}   String   - channel id
 * @param   {{from: String}}      String   - channel group
 *
 * @returns {number}  number    - amount of videos updated
 * @returns {number}  number    - amount of channels updated
 */
async function fetchXML({ youtube, from }) {
  logger.api.helpers.xmlCrawler('crawling %s...', youtube);

  // fetch and parse xml feed
  const xmlFeed = await fetch(baseURL + youtube);
  const videoFeed = parseXML(xmlFeed);

  // get the latest video
  const [latestVideo] = videoFeed;

  // save entire list for first run and cache first video
  if (!videoCache[youtube]) {
    videoCache[youtube] = latestVideo;
    logger.api.helpers.xmlCrawler('saving %d videos from %s...', videoFeed.length, youtube);
    return saveVideos(youtube, from, videoFeed);
  }

  // if cached timestamp is still same as latest video, ignore
  if (latestVideo.timestamp === videoCache[youtube].timestamp) {
    logger.api.helpers.xmlCrawler('no new videos found from %s.', youtube);
    return [0, 0]; // return two 0's for logging purposes
  }

  // replace cached video and save to db
  videoCache[youtube] = latestVideo;
  logger.api.xmlCrawler('new video found from %s', youtube);
  return saveVideos(youtube, from, [latestVideo]);
}

/**
 * Saves videos to db and updates channel
 *
 * @param {String}    youtube
 * @param {String}    group
 * @param {{
 *   _id: String,
 *   title: String,
 *   channel: String
 * }[]}               videos
 * @param {Boolean}   firstrun
 *
 * @returns {number}  number    - amount of videos updated
 * @returns {number}  number    - amount of channels updated
 */
async function saveVideos(youtube, group, videos, firstrun) {
  logger.db.api_data('updating %d videos from %s...', videos.length, youtube);
  const bulk = api_data.videos.initializeUnorderedBulkOp();

  // assign write ops to db
  cloneObject(videos).map(video =>
    delete video.timestamp
    && bulk
      .find({ '_id': video._id })
      .upsert()
      .updateOne({ $setOnInsert: {
        ...TEMPLATE,
        ...video,
        group
      } })
  );

  // update channel info
  await api_data.channels.update(
    { youtube },
    { $set: { 'crawled_at': Date.now() } }
  );

  // write videos to db and log results
  const results = await bulk.execute();
  logger.db.api_data('sucessfully updated %d videos from %s at %s.',
    results.nUpserted,
    youtube,
    new Date().toLocaleString('en-GB')
  );

  firstrun && logger.api.helpers.xmlCrawler('saved %d videos.', results.nUpserted);
  return [results.nUpserted, 1];
}

function parseXML(xml) {
  return [...xml.matchAll(re)]
    .map(parseData)
    .sort(byDate);
}

function parseData([, _id, channel, title, timestamp]) {
  return { _id, title, channel, timestamp };
}

function byDate(latest, older) {
  /* eslint-disable indent,no-multi-spaces*/
  return latest.timestamp > older.timestamp ?  1 :
         latest.timestamp < older.timestamp ? -1 :
                                               0 ;
  /* eslint-enable indent,no-multi-spaces*/
}

function countUpdated([totalVideos, totalChannels], [videos, channels]) {
  totalVideos += videos;
  totalChannels += channels;
  return [totalVideos, totalChannels];
}

function cloneObject(object) {
  return JSON.parse(JSON.stringify(object));
}
