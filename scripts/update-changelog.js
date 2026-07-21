const fs = require('fs');
const path = require('path');

const version = process.env.RELEASE_VERSION;
const date = process.env.RELEASE_DATE;
const prNumber = process.env.PR_NUMBER;
const prTitle = process.env.PR_TITLE;
const prUrl = process.env.PR_URL;

if (!version || !date || !prNumber || !prTitle || !prUrl) {
  throw new Error('RELEASE_VERSION, RELEASE_DATE, PR_NUMBER, PR_TITLE, and PR_URL are required.');
}

const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
// Normalise CRLF → LF so the marker check works on Windows runners.
const changelog = fs.readFileSync(changelogPath, 'utf8').replace(/\r\n/g, '\n');
const heading = `## [${version}]`;

if (changelog.includes(heading)) {
  console.log(`Changelog already contains ${heading}.`);
  process.exit(0);
}

const title = prTitle.replace(/[\r\n]+/g, ' ').trim();
const entry = `${heading} - ${date}\n\n### Dependencies\n\n- ${title} ([#${prNumber}](${prUrl}))\n\n`;
const marker = '## [Unreleased]\n\n';

if (!changelog.includes(marker)) {
  throw new Error('CHANGELOG.md must contain an "## [Unreleased]" section.');
}

fs.writeFileSync(changelogPath, changelog.replace(marker, `${marker}${entry}`));
console.log(`Added changelog entry for v${version}.`);
