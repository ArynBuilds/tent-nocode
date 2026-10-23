import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// TikTok Content Posting integration: publish photo/video posts by URL; publishing is async, status read separately.
// TikTok uses client_key and comma-separated scopes; the standard oauth builder needs widening before this flips ready.
export const tiktok: IntegrationDef = {
  name: 'tiktok',
  version: 1,
  displayName: 'TikTok',
  blurb: 'Publish photos and videos to your own TikTok account straight from your app.',
  category: 'social',
  surfaces: 'both',
  scope: 'builder',
  // Waits on app registration and TikTok's content-posting audit; unaudited clients can only post privately.
  availability: 'upcoming',
  hosts: ['https://open.tiktokapis.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: ['video.publish'],
    clientEnv: 'TIKTOK',
    tokenHelp: 'Sign in with your TikTok account when connecting - Tent NoCode holds the keys, nothing to paste.',
  },
  endpoints: [
    {
      id: 'post-photo',
      displayName: 'Publish a photo post',
      method: 'POST',
      path: '/v2/post/publish/content/init/',
      class: 'send',
      params: {
        title: {
          type: 'string',
          at: 'post_info.title',
          help: 'The post title, up to 90 characters.',
        },
        description: {
          type: 'string',
          at: 'post_info.description',
          help: 'The caption under the post, up to 4000 characters.',
        },
        privacy_level: {
          type: 'string',
          required: true,
          at: 'post_info.privacy_level',
          choices: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
          help: 'Who can see the post.',
        },
        photo_url: {
          type: 'string',
          required: true,
          at: 'source_info.photo_images.0',
          help: 'A public https link to the photo, on a domain verified with TikTok.',
        },
        auto_add_music: {
          type: 'boolean',
          at: 'post_info.auto_add_music',
          help: 'Let TikTok add recommended music to the post.',
        },
      },
      body: 'json',
      bodyConstants: {
        media_type: 'PHOTO',
        post_mode: 'DIRECT_POST',
        'source_info.source': 'PULL_FROM_URL',
      },
      picks: [{ field: 'publish_id', from: 'data.publish_id' }],
    },
    {
      id: 'post-video',
      displayName: 'Publish a video post',
      method: 'POST',
      path: '/v2/post/publish/video/init/',
      class: 'send',
      params: {
        title: {
          type: 'string',
          at: 'post_info.title',
          help: 'The video caption, up to 2200 characters.',
        },
        privacy_level: {
          type: 'string',
          required: true,
          at: 'post_info.privacy_level',
          choices: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
          help: 'Who can see the post.',
        },
        video_url: {
          type: 'string',
          required: true,
          at: 'source_info.video_url',
          help: 'A public https link to the video file, on a domain verified with TikTok.',
        },
        disable_comment: {
          type: 'boolean',
          at: 'post_info.disable_comment',
          help: 'Turn off comments on the post.',
        },
      },
      body: 'json',
      bodyConstants: {
        'source_info.source': 'PULL_FROM_URL',
      },
      picks: [{ field: 'publish_id', from: 'data.publish_id' }],
    },
    {
      id: 'post-status',
      displayName: 'Check how a post is doing',
      method: 'POST',
      path: '/v2/post/publish/status/fetch/',
      class: 'read',
      params: {
        publish_id: {
          type: 'string',
          required: true,
          help: 'The publish id a post call returned.',
        },
      },
      body: 'json',
      picks: [
        { field: 'status', from: 'data.status' },
        { field: 'fail_reason', from: 'data.fail_reason' },
      ],
    },
  ],
  inside: {
    // Published posts land here, app grain; the publish-id is the receipt.
    tables: [
      {
        name: 'sent-posts',
        displayName: 'Sent posts',
        rowSchema: {
          title: 'string',
          'privacy-level': 'string',
          'publish-id': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_title',
      label: 'Post caption',
      kind: 'template',
      help: 'The caption with field slots, or bind an input on screen.',
    },
    {
      id: 'default_privacy_level',
      label: 'Who can see posts',
      kind: 'enum',
      choices: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
      help: 'Who can see posts your app publishes by default.',
    },
  ],
  fixtures: [
    {
      endpoint: 'post-photo',
      params: {
        title: 'Sunny day',
        description: 'Photos from the workshop',
        privacy_level: 'PUBLIC_TO_EVERYONE',
        photo_url: 'https://media.example.com/photos/one.jpg',
      },
      status: 200,
      response: {
        data: { publish_id: 'p_pub_url~v2.123456789' },
        error: { code: 'ok', message: '', log_id: '202210112248442CB9319E1FB30C1073F3' },
      },
    },
    {
      endpoint: 'post-video',
      params: {
        title: 'This will be a fun video',
        privacy_level: 'MUTUAL_FOLLOW_FRIENDS',
        video_url: 'https://media.example.com/videos/one.mp4',
      },
      status: 200,
      response: {
        data: { publish_id: 'v_pub_url~v2-1.123456789' },
        error: { code: 'ok', message: '', log_id: '202210112248442CB9319E1FB30C1073F4' },
      },
    },
    {
      endpoint: 'post-status',
      params: { publish_id: 'v_pub_url~v2-1.123456789' },
      status: 200,
      response: {
        data: { status: 'PUBLISH_COMPLETE' },
        error: { code: 'ok', message: '', log_id: '202210112248442CB9319E1FB30C1073F5' },
      },
    },
  ],
};
