/**
 * Web TV Hub email sender (Google Apps Script)
 * Sends Web TV Hub's emails (sign-up confirmations and show reminders) from this Google account.
 * Free; a consumer Gmail account can send about 100 emails a day.
 *
 * Setup (once, about 5 minutes):
 *  1. script.google.com → New project → paste this file → save. Name it "Web TV Hub sender".
 *  2. Run `makeSecret` (Run ▶ at the top). Allow the permissions it asks for, then copy the secret
 *     from the execution log at the bottom.
 *  3. Project Settings (⚙) → Script properties → Add: EMAIL_SECRET = the secret you copied.
 *  4. Cloudflare → Workers & Pages → webtv-hub → Settings → Variables and Secrets → Add →
 *     Type "Secret", name EMAIL_SECRET, same value → Save.
 *  5. Back here, run `setup`. It checks the connection every 10 minutes from now on.
 * Keep the secret private: it lets this script read the list of emails to send.
 */
const API = 'https://webtv-hub.pages.dev/api/email/due';

function makeSecret() {
  const s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  console.log('Your EMAIL_SECRET (keep it private):\n' + s);
  return s;
}

function setup() {
  const secret = PropertiesService.getScriptProperties().getProperty('EMAIL_SECRET');
  if (!secret || secret.length < 24) throw new Error('Add the EMAIL_SECRET script property first (step 3).');
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendDue').timeBased().everyMinutes(10).create();
  const n = sendDue();
  console.log('Set up. Checking every 10 minutes. Sent ' + n + ' email(s) just now.');
}

function sendDue() {
  const secret = PropertiesService.getScriptProperties().getProperty('EMAIL_SECRET');
  const quota = MailApp.getRemainingDailyQuota();
  if (quota < 1) { console.warn('Daily Gmail quota used up; trying again later.'); return 0; }
  const res = UrlFetchApp.fetch(API + '?max=' + quota, { headers: { Authorization: 'Bearer ' + secret }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { console.error('Web TV Hub answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200)); return 0; }
  const data = JSON.parse(res.getContentText());
  if (data.error) { console.error('Web TV Hub: ' + data.error + ' (check that EMAIL_SECRET matches in Cloudflare and here)'); return 0; }
  let sent = 0;
  (data.messages || []).forEach(function (m) {
    try {
      MailApp.sendEmail({ to: m.to, subject: m.subject, htmlBody: m.html, body: m.text, name: 'Web TV Hub' });
      sent++;
    } catch (e) { console.error('Could not send to one recipient: ' + e); }
  });
  return sent;
}
