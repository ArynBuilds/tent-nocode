import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// TMDB read-only movie data integration.
export const tmdb: IntegrationDef = {
  name: 'tmdb',
  version: 1,
  displayName: 'TMDB',
  blurb: 'Bring movie search and trending titles into your app on your own TMDB account.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.themoviedb.org'],
  auth: {
    kind: 'bearer',
    secretName: 'TMDB_READ_TOKEN',
    tokenHelp: 'Your API Read Access Token, under Settings then API in your TMDB account.',
  },
  endpoints: [
    {
      id: 'search-movies',
      displayName: 'Search for movies',
      method: 'GET',
      path: '/3/search/movie',
      class: 'read',
      params: {
        query: { type: 'string', required: true, help: 'What to search for, like Fight Club.' },
        language: { type: 'string', help: 'Like en-US.' },
        page: { type: 'number', help: 'Which page of results, starting at 1.' },
      },
      picks: [
        { field: 'movie_id', from: 'results.0.id' },
        { field: 'title', from: 'results.0.title' },
        { field: 'overview', from: 'results.0.overview' },
        { field: 'release_date', from: 'results.0.release_date' },
        { field: 'vote_average', from: 'results.0.vote_average' },
        { field: 'poster_path', from: 'results.0.poster_path' },
      ],
    },
    {
      id: 'trending-movies',
      displayName: 'See trending movies',
      method: 'GET',
      path: '/3/trending/movie/{time_window}',
      class: 'read',
      params: {
        time_window: { type: 'string', required: true, choices: ['day', 'week'], help: 'Trending today or this week.' },
        language: { type: 'string', help: 'Like en-US.' },
      },
      picks: [
        { field: 'movie_id', from: 'results.0.id' },
        { field: 'title', from: 'results.0.title' },
        { field: 'overview', from: 'results.0.overview' },
        { field: 'release_date', from: 'results.0.release_date' },
        { field: 'vote_average', from: 'results.0.vote_average' },
        { field: 'poster_path', from: 'results.0.poster_path' },
      ],
    },
  ],
  inside: {
    // Movie rows pull once per app; kebab columns match their snake pick twins.
    tables: [
      {
        name: 'movies',
        displayName: 'Movies',
        rowSchema: {
          'movie-id': 'number',
          title: 'string',
          overview: 'string',
          'release-date': 'string',
          'vote-average': 'number',
          'poster-path': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    // Setting names match the endpoint params they fill.
    { id: 'default_query', label: 'Search for', kind: 'text', help: 'What the app searches for when nothing else is bound.' },
    { id: 'time_window', label: 'Trending window', kind: 'enum', choices: ['day', 'week'], help: 'Trending today or this week.' },
    { id: 'language', label: 'Language', kind: 'text', help: 'Like en-US.' },
  ],
  fixtures: [
    {
      endpoint: 'search-movies',
      params: { query: 'Fight Club' },
      status: 200,
      response: {
        page: 1,
        results: [
          {
            adult: false,
            backdrop_path: '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
            genre_ids: [18, 53, 35],
            id: 550,
            original_language: 'en',
            original_title: 'Fight Club',
            overview: 'A ticking-time-bomb insomniac and a slippery soap salesman channel primal male aggression into a shocking new form of therapy.',
            popularity: 73.433,
            poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
            release_date: '1999-10-15',
            title: 'Fight Club',
            video: false,
            vote_average: 8.433,
            vote_count: 26279,
          },
        ],
        total_pages: 2,
        total_results: 39,
      },
    },
    {
      endpoint: 'trending-movies',
      params: { time_window: 'day' },
      status: 200,
      response: {
        page: 1,
        results: [
          {
            adult: false,
            backdrop_path: '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
            id: 550,
            title: 'Fight Club',
            original_language: 'en',
            original_title: 'Fight Club',
            overview: 'A ticking-time-bomb insomniac and a slippery soap salesman channel primal male aggression into a shocking new form of therapy.',
            poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
            media_type: 'movie',
            genre_ids: [18, 53, 35],
            popularity: 73.433,
            release_date: '1999-10-15',
            video: false,
            vote_average: 8.433,
            vote_count: 26279,
          },
        ],
        total_pages: 500,
        total_results: 10000,
      },
    },
  ],
};
