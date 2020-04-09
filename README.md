# bracket-role-assign
For those running onilne tournaments, this is a script that assigns roles to
Discord server members based on (smashgg, for now) tournament registration.
It will also give nicknames to server members if their Discord usernames
don't match their smashgg gamertags.

## What you'll need:
* [Node.js] 12 or newer
* [A smash.gg API token][smashggToken]
* [A Discord bot token][discordToken] that has the following permissions on your server:
  * `Manages Roles`
  * `Manage Nicknames`

## Getting Started
1. Create a `credentials.json` file with these tokens. Use
[`credentials.example.json`](credentials.example.json) as a reference.

1. Create a `config.json` file that contains your [Discord server
ID][discordIds], and a mapping from Discord role ID to either [smash.gg game
ID][smashggIds] or the game name. Use
[`config.example.json`](config.example.json) as a reference.

1. `npm ci`

1. `npm start -- [smashgg tournament slug]`

[Node.js]: https://nodejs.org
[smashggToken]: https://developer.smash.gg/docs/authentication
[smashggIds]: https://docs.google.com/spreadsheets/d/1l-mcho90yDq4TWD-Y9A22oqFXGo8-gBDJP0eTmRpTaQ/edit#gid=1924677423
[discordToken]: https://discordapp.com/developers/applications
[discordIds]: https://support.discordapp.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID-
