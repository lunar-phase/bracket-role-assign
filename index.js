#!/usr/bin/env node
const Discord = require('discord.js');
const fs = require('fs').promises;
const { GraphQLClient } = require('graphql-request');
const fetch = require('node-fetch');
const similarity = require('string-similarity').compareTwoStrings;

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

  await removeRolesFromMembers(members, roles);

  const players = await getPlayersAndRoles(graphqlClient, tournamentSlug, members, config.roles);

  await Promise.all(players.map(addRoles));

  await Promise.all(players.map(setNickname));

  discordClient.destroy();
}

async function getDiscordClient(credentials) {
  const discordClient = new Discord.Client();
  await discordClient.login(credentials.discord);
  console.log(`Logged in as ${discordClient.user.tag}!`);
  return discordClient;
}

function getGuild(discordClient, serverId) {
  const guild = discordClient.guilds.resolve(serverId);
  if (!guild) {
    console.error(`Unable to find server: ${guild.id}`);
    process.exit();
  }
  console.log(`Server: ${guild.id}`);
  return guild;
}

async function getRoles(guild, roleIds) {
  const roles = Array.from((await guild.roles.fetch()).cache.values())
    .filter(role => roleIds.includes(role.id));
  if (!roles.length) {
    console.error(`None of the given roles found on server: ${roleIds}`);
    process.exit();
  }
  return roles;
}

async function getMembers(guild) {
  return Array.from((await guild.members.fetch()).values());
}

async function removeRolesFromMembers(members, roles) {
  const roleIds = roles.map(r => r.id);
  const membersWithRoles = members.filter(m => roleIds.some(id => m.roles.cache.has(id)));
  console.log(`Removing roles [${roles.map(r => r.name).join(', ')}] from ${membersWithRoles.length} members`);
  await Promise.all(membersWithRoles.map(m => m.roles.remove(roleIds)));
}

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
    const fullHandle = participant.prefix && `${participant.prefix} | ${participant.gamerTag}`;
    console.log(`Looking for ${fullHandle}`);
    member = members.find(m => m.user.username === handle ||
      m.user.username === fullHandle ||
      m.displayName === handle ||
      m.displayName === fullHandle);
  }
  if (member) {
    console.log(`Found: ${member.user.tag}`);
  } else {
    console.log('Not member found');
  }
  return member;
}

async function addRoles(player) {
  console.log(`Adding role(s) ${player.roles} to ${player.member.displayName}`)
  await player.member.roles.add(player.roles);
}

async function setNickname(player) {
  const handle = player.handle;
  const fullHandle = player.prefix ? `${player.prefix} | ${handle}` : handle;
  const displayNameLower = player.member.displayName.toLowerCase();
  const similarities = [
    similarity(handle.toLowerCase(), displayNameLower),
    similarity(fullHandle.toLowerCase(), displayNameLower),
  ];
  if (similarities.some(s => s > 0.8)) {
    return;
  }
  console.log(`Renaming ${player.member.displayName} to ${fullHandle}`);
  await player.member.setNickname(fullHandle, 'Matching bracket name');
}

main().catch(console.error);
