// Catalog shelf; one def per file, closed import list.
import type { IntegrationDefInput } from '../catalog.js';
import { webhookOut } from './webhook-out.js';
import { httpRequest } from './http-request.js';
import { resend } from './resend.js';
import { slack } from './slack.js';
import { exchangerate } from './exchangerate.js';
import { twilio } from './twilio.js';
import { sendgrid } from './sendgrid.js';
import { telegram } from './telegram.js';
import { openweather } from './openweather.js';
import { brevo } from './brevo.js';
import { loops } from './loops.js';
import { mailgun } from './mailgun.js';
import { asana } from './asana.js';
import { clickup } from './clickup.js';
import { todoist } from './todoist.js';
import { calendly } from './calendly.js';
import { coingecko } from './coingecko.js';
import { mailchimp } from './mailchimp.js';
import { klaviyo } from './klaviyo.js';
import { monday } from './monday.js';
import { calCom } from './cal-com.js';
import { linear } from './linear.js';
import { attio } from './attio.js';
import { onesignal } from './onesignal.js';
import { gitlab } from './gitlab.js';
import { sentry } from './sentry.js';
import { plausible } from './plausible.js';
import { posthog } from './posthog.js';
import { mixpanel } from './mixpanel.js';
import { serper } from './serper.js';
import { tavily } from './tavily.js';
import { firecrawl } from './firecrawl.js';
import { newsapi } from './newsapi.js';
import { tmdb } from './tmdb.js';
import { mapbox } from './mapbox.js';
import { pushover } from './pushover.js';
import { mastodon } from './mastodon.js';
import { buffer } from './buffer.js';
import { printful } from './printful.js';
import { printify } from './printify.js';
import { docuseal } from './docuseal.js';
import { pandadoc } from './pandadoc.js';
import { hunter } from './hunter.js';
import { apollo } from './apollo.js';
import { ipinfo } from './ipinfo.js';
import { opencage } from './opencage.js';
import { weatherapi } from './weatherapi.js';
import { stripe } from './stripe.js';
import { paddle } from './paddle.js';
import { lemonSqueezy } from './lemon-squeezy.js';
import { paypal } from './paypal.js';
import { notion } from './notion.js';
import { airtable } from './airtable.js';
import { gmail } from './gmail.js';
import { googleSheets } from './google-sheets.js';
import { googleCalendar } from './google-calendar.js';
import { googleDrive } from './google-drive.js';
import { googleAnalytics } from './google-analytics.js';
import { youtube } from './youtube.js';
import { microsoftGraph } from './microsoft-graph.js';
import { salesforce } from './salesforce.js';
import { xTwitter } from './x-twitter.js';
import { linkedin } from './linkedin.js';
import { metaPages } from './meta-pages.js';
import { reddit } from './reddit.js';
import { dropbox } from './dropbox.js';
import { quickbooks } from './quickbooks.js';
import { xero } from './xero.js';
import { supabase } from './supabase.js';
import { tiktok } from './tiktok.js';
import { pinterest } from './pinterest.js';
import { box } from './box.js';
import { freshbooks } from './freshbooks.js';
import { wave } from './wave.js';
import { etsy } from './etsy.js';
import { ebay } from './ebay.js';
import { docusign } from './docusign.js';
import { basecamp } from './basecamp.js';
import { spotify } from './spotify.js';

export const INTEGRATION_DEFS: IntegrationDefInput[] = [
  webhookOut, httpRequest, resend, slack, exchangerate,
  twilio, sendgrid, telegram, openweather,
  brevo, loops, mailgun, asana, clickup, todoist, calendly, coingecko,
  mailchimp, klaviyo, monday, calCom, linear,
  attio, onesignal, gitlab, sentry, plausible, posthog, mixpanel,
  serper, tavily, firecrawl, newsapi, tmdb, mapbox,
  pushover, mastodon, buffer, printful, printify, docuseal, pandadoc,
  hunter, apollo, ipinfo, opencage, weatherapi,
  stripe, paddle, lemonSqueezy, paypal,
  notion, airtable,
  gmail, googleSheets, googleCalendar, googleDrive, googleAnalytics, youtube,
  microsoftGraph, salesforce, xTwitter, linkedin, metaPages, reddit,
  dropbox, quickbooks, xero,
  tiktok, pinterest, box, freshbooks, wave, etsy, ebay, docusign, basecamp, spotify,
  supabase,
];
