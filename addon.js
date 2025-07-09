const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const querystring = require('querystring'); // Needed to parse query params if you use URL-based config
const url = require('url'); // Needed to parse the addon URL for initial config if not POSTing

// --- Configuration ---
// IMPORTANT: Set your TMDB API Key as an environment variable in Render!
// For local testing (if you ever get an environment), you could set it directly:
// const TMDB_API_KEY = 'YOUR_TMDB_API_KEY_HERE';
const TMDB_API_KEY = process.env.TMDB_API_KEY; // This will be read from Render's environment variables

const PORT = process.env.PORT || 7000; // Render will set process.env.PORT

// This will store the debrid key temporarily for this running instance of the addon.
// It will reset if the Render Free Tier service spins down due to inactivity.
let GLOBAL_DEBRID_API_KEY = '';

const builder = new addonBuilder({
  id: 'com.youraddon.arabiccontent',
  version: '1.0.0',
  name: 'Arabic Stream Hub',
  description: 'Find and stream the latest Arabic movies, series, and shows with optional debrid integration.',
  resources: ['catalog', 'stream', 'meta', 'configure'], // Add 'configure' for user settings
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'arabic_movies_latest',
      name: 'أفلام عربية حديثة', // Latest Arabic Movies
      extra: [{ name: 'genre' }, { name: 'skip', isRequired: false }]
    },
    {
      type: 'series',
      id: 'arabic_series_latest',
      name: 'مسلسلات عربية حديثة', // Latest Arabic Series
      extra: [{ name: 'genre' }, { name: 'skip', isRequired: false }]
    }
  ],
  idPrefixes: ['tt'] // For IMDb IDs often used with torrents
});

// --- Catalog Handler (TMDB Integration) ---
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    let tmdbUrl = '';
    if (type === 'movie' && id === 'arabic_movies_latest') {
      // Discover Arabic movies, ordered by popularity. You can adjust filters.
      tmdbUrl = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&language=ar-AE&sort_by=popularity.desc`;
    } else if (type === 'series' && id === 'arabic_series_latest') {
      // Discover Arabic TV shows
      tmdbUrl = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&language=ar-AE&sort_by=popularity.desc`;
    } else {
      return Promise.reject(new Error('Unsupported catalog type or ID'));
    }

    const page = (extra && extra.skip) ? Math.floor(extra.skip / 20) + 1 : 1;
    tmdbUrl += `&page=${page}`;

    const response = await axios.get(tmdbUrl);
    const tmdbItems = response.data.results;

    const metas = tmdbItems.map(item => ({
      id: `tt${item.imdb_id || item.id}`, // Prioritize IMDb ID for broader compatibility
      type: type,
      name: item.title || item.name,
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
      background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
      description: item.overview,
      releaseInfo: item.release_date || item.first_air_date,
      genres: item.genre_ids ? item.genre_ids.map(id => getGenreName(id)) : [],
    }));

    return Promise.resolve({ metas });
  } catch (error) {
    console.error('Error fetching catalog:', error.message);
    return Promise.reject(new Error('Could not fetch catalog from TMDB. Please check your TMDB API Key.'));
  }
});

// --- Stream Handler (Torrent & Debrid Integration) ---
builder.defineStreamHandler(async ({ type, id }) => {
  const streams = [];
  const debridApiKey = GLOBAL_DEBRID_API_KEY; // Use the key from global variable (set by configure)

  // Extract TMDB/IMDb ID
  const contentId = id.startsWith('tt') ? id.substring(2) : id;

  let title = '';
  let year = '';
  try {
      const tmdbDetailsUrl = `https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${contentId}?api_key=${TMDB_API_KEY}&language=ar-AE`;
      const tmdbDetailsResponse = await axios.get(tmdbDetailsUrl);
      title = tmdbDetailsResponse.data.title || tmdbDetailsResponse.data.name;
      year = (tmdbDetailsResponse.data.release_date || tmdbDetailsResponse.data.first_air_date || '').substring(0, 4);
  } catch (detailError) {
      console.warn(`Could not get TMDB details for ${id}:`, detailError.message);
      // Continue without full details, but torrent search might be less accurate
      title = `Content ID: ${id}`; // Fallback title for torrent search
  }

  // --- CRUCIAL SECTION: TORRENT SEARCH ---
  // This is the most complex part to implement without a local environment for testing web scrapers.
  // For initial testing, you can manually find magnet links for some popular Arabic content
  // (e.g., from public torrent sites or forums) and hardcode them here.
  //
  // For a real-world, dynamic solution:
  // You would need to integrate with a reliable torrent API (if one exists for Arabic content)
  // or implement web scraping. Web scraping is highly prone to breaking when websites change
  // and is very difficult to debug without a local environment.
  //
  // Example of a placeholder where you'd put magnet links:
  const potentialMagnetLinks = [];
  // To test: find a magnet link for a known Arabic movie/series
  // Example: potentialMagnetLinks.push('magnet:?xt=urn:btih:A_REAL_MAGNET_HASH_FOR_ARABIC_CONTENT&dn=Movie.Title.2023.HDRip');
  // Replace A_REAL_MAGNET_HASH_FOR_ARABIC_CONTENT with an actual magnet hash.

  // --- Process Torrents (Debrid and P2P Fallback) ---
  for (const magnet of potentialMagnetLinks) {
    // 1. Try Debrid Service first if API key is present
    if (debridApiKey) {
      try {
        const debridServiceEndpoint = 'https://api.real-debrid.com/rest/1.0';

        // Add magnet to Real-Debrid
        const addMagnetResponse = await axios.post(
          `${debridServiceEndpoint}/torrents/addMagnet`,
          `magnet=${encodeURIComponent(magnet)}`,
          {
            headers: {
              'Authorization': `Bearer ${debridApiKey}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );

        const torrentId = addMagnetResponse.data.id;

        // Get torrent info and files
        const torrentInfoResponse = await axios.get(
          `${debridServiceEndpoint}/torrents/info/${torrentId}`,
          {
            headers: {
              'Authorization': `Bearer ${debridApiKey}`
            }
          }
        );

        const files = torrentInfoResponse.data.files;
        // Select the largest video file
        const mainFile = files.reduce((prev, current) => {
          const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.webm'];
          if (videoExtensions.some(ext => current.path.toLowerCase().endsWith(ext))) {
            return (prev && prev.bytes > current.bytes) ? prev : current;
          }
          return prev;
        }, null);

        if (mainFile && torrentInfoResponse.data.links && torrentInfoResponse.data.links.length > 0) {
          // Unrestrict the file (get direct link)
          const unrestrictResponse = await axios.post(
            `${debridServiceEndpoint}/unrestrict/link`,
            `link=${encodeURIComponent(torrentInfoResponse.data.links[0])}`, // Often, the first link is the one to unrestrict
            {
              headers: {
                'Authorization': `Bearer ${debridApiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          );

          if (unrestrictResponse.data.stream_link) {
            streams.push({
              url: unrestrictResponse.data.stream_link,
              title: `[RD+] ${mainFile.path.split('/').pop()}`, // Label as Real-Debrid
            });
          }
        } else {
             console.warn(`No streamable files found on debrid for magnet: ${magnet}`);
             // Fallback to P2P if debrid couldn't find streamable link
             const infoHashMatch = magnet.match(/btih:([a-zA-Z0-9]{40})/);
             if (infoHashMatch && infoHashMatch[1]) {
                 streams.push({
                     infoHash: infoHashMatch[1],
                     sources: [magnet],
                     title: `[P2P] ${title} (Torrent)`, // Label as P2P
                 });
             }
        }
      } catch (debridError) {
        console.warn(`Debrid service failed for magnet ${magnet}:`, debridError.message);
        // If debrid fails for a magnet, we can fall back to direct P2P
        const infoHashMatch = magnet.match(/btih:([a-zA-Z0-9]{40})/);
        if (infoHashMatch && infoHashMatch[1]) {
            streams.push({
                infoHash: infoHashMatch[1],
                sources: [magnet],
                title: `[P2P] ${title} (Torrent)`, // Label as P2P
            });
        }
      }
    } else {
      // No debrid key provided, or debrid failed, add direct P2P torrent stream
      const infoHashMatch = magnet.match(/btih:([a-zA-Z0-9]{40})/);
      if (infoHashMatch && infoHashMatch[1]) {
          streams.push({
            infoHash: infoHashMatch[1], // Extract infoHash from magnet
            sources: [magnet], // Provide the magnet link
            title: `[P2P] ${title} (Torrent)`, // Label as P2P
          });
      } else {
          console.warn(`Invalid magnet link format: ${magnet}`);
      }
    }
  }

  return Promise.resolve({ streams });
});


// --- Configure Handler (for User Debrid API Key) ---
// This handler manages the user's Real-Debrid API key input.
builder.defineConfigureHandler(async (args) => {
    // If a POST request comes in (from form submission)
    if (args.method === 'POST' && args.body) {
        const formData = querystring.parse(args.body.toString());
        const debridApiKey = formData.DEBRID_API_KEY;
        if (debridApiKey) {
            GLOBAL_DEBRID_API_KEY = debridApiKey; // Store for this running instance
            console.log("Debrid API Key received and set (hidden for security in logs).");
            return Promise.resolve({
                html: `
                    <html>
                        <head>
                            <style>body { font-family: sans-serif; margin: 20px; } .message { color: green; }</style>
                        </head>
                        <body>
                            <h1>Configuration Saved!</h1>
                            <p class="message">Your Real-Debrid API Key has been saved for this addon instance.</p>
                            <p><strong>Important:</strong> If this free Render service sleeps and restarts due to inactivity, you may need to re-enter the key.</p>
                            <p>Return to Stremio and refresh the addon or restart Stremio to ensure changes are applied.</p>
                            <p><a href="/configure">Go back to configuration</a></p>
                        </body>
                    </html>
                `
            });
        } else {
             return Promise.resolve({
                html: `
                    <html>
                        <head>
                            <style>body { font-family: sans-serif; margin: 20px; } .error { color: red; }</style>
                        </head>
                        <body>
                            <h1>Configuration Error</h1>
                            <p class="error">Please enter a valid Real-Debrid API Key.</p>
                            <p><a href="/configure">Go back to configuration</a></p>
                        </body>
                    </html>
                `
            });
        }
    }

    // Default GET request for the configuration form
    const html = `
        <html>
        <head>
            <title>Configure Arabic Stream Hub</title>
            <style>
            body { font-family: sans-serif; margin: 20px; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            input[type="text"] { width: 300px; padding: 8px; margin-bottom: 15px; border: 1px solid #ccc; border-radius: 4px; }
            button { padding: 10px 15px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
            button:hover { background-color: #0056b3; }
            .message { margin-top: 20px; color: green; }
            .error { color: red; }
            </style>
        </head>
        <body>
            <h1>Configure Arabic Stream Hub Addon</h1>
            <p>Please enter your Real-Debrid API Key if you have one. If not, the addon will attempt to use direct torrent (P2P) streaming.</p>
            <form method="POST" action="/configure">
            <label for="debridApiKey">Real-Debrid API Key (Optional):</label>
            <input type="text" id="debridApiKey" name="DEBRID_API_KEY" placeholder="e.g., yourlongrealdebridapikey">
            <button type="submit">Save Configuration</button>
            </form>
        </body>
        </html>
    `;
    return Promise.resolve({ html });
});


// Helper function to map TMDB genre IDs to names (you can extend this list)
function getGenreName(id) {
    const genres = {
        28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
        99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
        27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction',
        10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
    };
    return genres[id] || 'Unknown';
}

// Start the HTTP server
serveHTTP(builder.get = getInterface(), { port: PORT });
console.log(`Stremio Arabic Content Addon starting on port ${PORT}`);

// Log the expected addon URL for easy access in Render logs
// Note: STREMIO_ADDON_URL is usually set by Stremio SDK in certain environments
console.log(`Addon URL: ${process.env.STREMIO_ADDON_URL || `http://localhost:${PORT}/manifest.json`}`);

