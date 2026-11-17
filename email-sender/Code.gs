/**
 * Web TV Hub email sender (Google Apps Script)
 * Sends Web TV Hub's emails (sign-up confirmations and show reminders) from this Google account.
 * Free; a regular Gmail account can send about 100 emails a day.
 *
 * Setup: open this project, choose `setup` in the function menu, press Run, and click Allow.
 * It then checks for emails to send every 10 minutes.
 *
 * Security: no password or secret is stored here. The script proves who it is with a Google-signed
 * sign-in token for this account, and Web TV Hub only answers the account registered as the sender.
 */
const API = 'https://webtv-hub.pages.dev/api/email/due';

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendDue').timeBased().everyMinutes(10).create();
  const n = sendDue();
  console.log('All set. Web TV Hub emails are checked every 10 minutes. Sent ' + n + ' just now.');
}

function sendDue() {
  const quota = MailApp.getRemainingDailyQuota();
  if (quota < 1) { console.warn('Daily Gmail quota used up; trying again later.'); return 0; }
  const res = UrlFetchApp.fetch(API + '?max=' + quota, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getIdentityToken() }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) { console.error('Web TV Hub answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200)); return 0; }
  const data = JSON.parse(res.getContentText());
  if (data.error) {
    console.error('Web TV Hub said: ' + data.error + '. This script must run in the Google account registered as the sender (' + Session.getActiveUser().getEmail() + ' is running it).');
    return 0;
  }
  let sent = 0;
  (data.messages || []).forEach(function (m) {
    try { MailApp.sendEmail({ to: m.to, subject: m.subject, htmlBody: m.html, body: m.text, name: 'Web TV Hub' }); sent++; }
    catch (e) { console.error('Could not send to one recipient: ' + e); }
  });
  return sent;
}
