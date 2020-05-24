#!/usr/bin/env node
const Discord = require('discord.js');
const fs = require('fs').promises;
const { GraphQLClient } = require('graphql-request');
const fetch = require('node-fetch');
const similarity = require('string-similarity').compareTwoStrings;

/** @typedef {import('discord.js').Client} DiscordClient */
/** @typedef {import('discord.js').Guild} Guild */
/** @typedef {import('discord.js').GuildMember} GuildMember */
/** @typedef {import('discord.js').Role} Role */
/** @typedef {import('discord.js').Snowflake} Snowflake */

/**
 * @typedef {Object} Player
 * @property {GuildMember} member
 * @property {Snowflake[]} roles
 * @property {string} handle
 * @property {string} prefix
 */

const EVENTS_QUERY = `
query EventsQuery($slug: String) {
  tournament(slug: $slug) {
    events {
      id
      videogame {
        id
        name
      }
    }
  }
}
`;

const ENTRANTS_QUERY = `
query EntrantsQuery($eventId: ID, $page: Int) {
  event(id: $eventId) {
    entrants(query: { perPage: 128, page: $page }) {
      nodes {
        participants {
          gamerTag
          prefix
          user {
            authorizations(types: [DISCORD]) {
              externalUsername
            }
          }
        }
      }
      pageInfo {
        totalPages
      }
    }
  }
}
`;

const SMASHGG_ENDPOINT = 'https://api.smash.gg/gql/alpha';

async function main() {
  const credentials = await fs.readFile('credentials.json', { encoding: 'utf8' })
    .then(JSON.parse);
  const config = await fs.readFile('config.json', { encoding: 'utf8' })
    .then(JSON.parse);
  const tournamentSlug = process.argv[2];

  const graphqlClient = new GraphQLClient(SMASHGG_ENDPOINT, {
    headers: { authorization: `Bearer ${credentials.smashgg}` },
  });
  const discordClient = await getDiscordClient(credentials);

  const guild = await getGuild(discordClient, config.server);
  const roles = await getRoles(guild,  Object.keys(config.roles));
  const members = await getMembers(guild);

  const players = await getPlayersAndRoles(graphqlClient, tournamentSlug, members, config.roles);

  await removeRolesForNonPlayers(roles, members, players);

  await Promise.all(players.map(p => setRoles(roles, p)));

  await Promise.all(players.map(setNickname));

  discordClient.destroy();
}

async function getDiscordClient(credentials) {
  const discordClient = new Discord.Client();
  await discordClient.login(credentials.discord);
  console.log(`Logged in as ${discordClient.user.tag}!`);
  return discordClient;
}

/**
 * @param {DiscordClient} discordClient
 * @param {Snowflake} serverId
 * @returns {Guild}
 */
function getGuild(discordClient, serverId) {
  const guild = discordClient.guilds.resolve(serverId);
  if (!guild) {
    console.error(`Unable to find server: ${guild.id}`);
    process.exit();
  }
  console.log(`Server: ${guild.id}`);
  return guild;
}

/**
 * @param {Guild} guild
 * @param {Snowflake[]} roleIds
 * @returns {Promise<Role[]>}
 */
async function getRoles(guild, roleIds) {
  const roles = Array.from((await guild.roles.fetch()).cache.values())
    .filter(role => roleIds.includes(role.id));
  if (!roles.length) {
    console.error(`None of the given roles found on server: ${roleIds}`);
    process.exit();
  }
  return roles;
}

/**
 * @param {Guild} guild
 * @returns {Promise<GuildMember[]>}
 */
async function getMembers(guild) {
  return Array.from((await guild.members.fetch()).values());
}

async function removeRolesFromMembers(members, roles) {
  const roleIds = roles.map(r => r.id);
  const membersWithRoles = members.filter(m => roleIds.some(id => m.roles.cache.has(id)));
  console.log(`Removing roles [${roles.map(r => r.name).join(', ')}] from ${membersWithRoles.length} members`);
  await Promise.all(membersWithRoles.map(m => m.roles.remove(roleIds)));
}

/**
 * @returns {Promise<Player[]>}
 */
async function getPlayersAndRoles(graphqlClient, tournamentSlug, members, rolesConfig) {
  const playersByDiscordId = {};
  const events = await getEvents(graphqlClient, tournamentSlug);
  for (const event of events) {
    const roleIds = getRolesIdsForVideogame(event.videogame, rolesConfig);
    if (!roleIds.length) {
      console.log(
        `No corresponding role found for ${event.videogame.name} (ID: ${event.videogame.id})`);
      continue;
    }

    const participants = await getEventParticipants(graphqlClient, event.id)
    for (const participant of participants) {
      const member = getMemberForParticipant(members, participant);
      if (!member) {
        continue;
      }
      const player = playersByDiscordId[member.id] || {
        member,
        roles: [],
        handle: participant.gamerTag,
        prefix: participant.prefix,
      };
      player.roles = player.roles.concat(roleIds);
      playersByDiscordId[member.id] = player;
    }
  }
  return Object.values(playersByDiscordId);
}

async function getEvents(graphqlClient, tournamentSlug) {
  const data = await graphqlClient.request(EVENTS_QUERY, { slug: tournamentSlug });
  if (!data.tournament) {
    console.error(`Unable to find tournament: ${tournamentSlug}`);
    process.exit();
  }
  return data.tournament.events;
}

/**
 * @returns {Snowflake[]}
 */
function getRolesIdsForVideogame(videogame, rolesConfig) {
  return Object.entries(rolesConfig)
    .filter(([ _, gameIdOrName ]) =>
      gameIdOrName == videogame.id || gameIdOrName == videogame.name)
    .map(([ roleId, _ ]) => roleId);
}

async function getEventParticipants(graphqlClient, eventId) {
  let participants = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const data = await graphqlClient.request(ENTRANTS_QUERY, { eventId, page });
    totalPages = data.event.entrants.pageInfo.totalPages;
    participants = participants.concat(data.event.entrants.nodes.flatMap(node => node.participants));
    page += 1;
  }
  return participants;
}

function getMemberForParticipant(members, participant) {
  let member;
  if (participant.user && participant.user.authorizations) {
    const discordTag = participant.user.authorizations[0].externalUsername;
    console.log(`Looking for ${discordTag}`);
    member = members.find(m => m.user.tag === discordTag);
  } else {
    // TODO(Adrian): Consider using a string similarity algorithm
    const handle = participant.gamerTag;
    const fullHandle = participant.prefix ? `${participant.prefix} | ${handle}` : handle;
    console.log(`Looking for ${fullHandle}`);
    member = members.find( m =>
      caseInsensitiveEquality(m.user.username, handle) ||
      caseInsensitiveEquality(m.user.username, fullHandle) ||
      caseInsensitiveEquality(m.displayName, handle) ||
      caseInsensitiveEquality(m.displayName, fullHandle));
  }
  if (member) {
    console.log(`Found: ${member.user.tag}\n`);
  } else {
    console.log('Member not found\n');
  }
  return member;
}

/**
 * @param {Role[]} managedRoles
 * @param {GuildMember[]} members
 * @param {Player[]} players
 * @returns {Promise<GuildMember[]>}
 */
async function removeRolesForNonPlayers(managedRoles, members, players) {
  const tournamentMemberIds = new Set(players.map(p => p.member.id));
  const roleIds = new Set(managedRoles.map(r => r.id));
  return Promise.all(
    members.filter(m => !tournamentMemberIds.has(m.id))
      .map(m => {
        if (Array.from(m.roles.cache.keys()).some(id => roleIds.has(id))) {
          console.log(`Removing role(s) ${managedRoles.map(r => r.name)} from ${m.displayName}`)
          return m.roles.remove(Array.from(roleIds));
        }
      })
  );
}

/**
 * @param {Role[]} managedRoles
 * @param {Player} player
 */
async function setRoles(managedRoles, player) {
  const current = Array.from(player.member.roles.cache.values()).map(v => v.id);
  const toAdd = player.roles.filter(id => !current.includes(id));
  const toRemove = managedRoles.map(r => r.id).filter(
    id => current.includes(id) && !player.roles.includes(id));
  /** @type {function(Snowflake[]): string[]} */
  const getNames = roleIds => roleIds.map(id => managedRoles.find(r => r.id == id).name);
  if (toAdd.length) {
    console.log(`Adding role(s) ${getNames(toAdd)} to ${player.member.displayName}`)
    await player.member.roles.add(toAdd);
  }
  if (toRemove.length) {
    console.log(`Removing role(s) ${getNames(toRemove)} from ${player.member.displayName}`)
    await player.member.roles.remove(toRemove);
  }
}

/**
 * @param {Player} player
 */
async function setNickname(player) {
  const handle = player.handle;
  const fullHandle = player.prefix ? `${player.prefix} | ${handle}` : handle;
  const displayNameLower = player.member.displayName.toLowerCase();
  /** @type {number[]} */
  const similarities = [
    similarity(handle.toLowerCase(), displayNameLower),
    similarity(fullHandle.toLowerCase(), displayNameLower),
    displayNameLower.includes(handle.toLowerCase()) ? 1 : 0,
  ];
  if (similarities.some(s => s > 0.8)) {
    return;
  }
  console.log(`Renaming ${player.member.displayName} to ${fullHandle}`);
  await player.member.setNickname(fullHandle, 'Matching bracket name');
}

/**
 * @param {string} str1
 * @param {string} str2
 * @returns {boolean}
 */
function caseInsensitiveEquality(str1, str2) {
  return str1.toLowerCase() === str2.toLowerCase();
}

main().catch(console.error);
