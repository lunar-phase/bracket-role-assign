#!/usr/bin/env node
const Discord = require('discord.js');
const fs = require('fs').promises;
const { GraphQLClient } = require('graphql-request');
const fetch = require('node-fetch');
const similarity = require('string-similarity').compareTwoStrings;

const ENTRANTS_QUERY = `
query EntrantsQuery($slug: String) {
  tournament(slug: $slug) {
    events {
      videogame {
        id
        name
      }
      entrants {
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
  const slug = process.argv[2];

  const graphQLClient = new GraphQLClient(SMASHGG_ENDPOINT, {
    headers: { authorization: `Bearer ${credentials.smashgg}` },
  });

  const discordClient = new Discord.Client();
  await discordClient.login(credentials.discord);
  console.log(`Logged in as ${discordClient.user.tag}!`);
  const guild = discordClient.guilds.resolve(config.server);
  if (!guild) {
    console.error(`Unable to find server: ${guild.id}`);
    process.exit();
  }
  console.log(`Server: ${guild.id}`);

  // Load roles/members
  const allRoleIds = Object.keys(config.roles);
  const allRoles = Array.from((await guild.roles.fetch()).cache.values())
    .filter(role => allRoleIds.includes(role.id));
  if (!allRoles.length) {
    console.error(`None of the given roles found on server: ${allRoleIds}`);
    process.exit();
  }
  const members = Array.from((await guild.members.fetch()).values());

  // Remove roles from all members
  const membersWithRoles = members.filter(m => allRoleIds.some(id => m.roles.cache.has(id)));
  console.log(`Removing roles [${allRoles.map(r => r.name).join(', ')}] from ${membersWithRoles.length} members`);
  await Promise.all(membersWithRoles.map(m => m.roles.remove(allRoleIds)));

  // Get roles to add for each server member
  // TODO(Adrian): Pagination
  const data = await graphQLClient.request(ENTRANTS_QUERY, { slug });
  if (!data.tournament) {
    console.error(`Unable to find tournament: ${slug}`);
    process.exit();
  }
  const events = data.tournament.events;
  const playersByDiscordId = {};
  for (const event of events) {
    const videogame = event.videogame;
    const roleIds = Object.entries(config.roles)
      .filter(([ _, gameIdOrName ]) => 
        gameIdOrName == videogame.id || gameIdOrName == videogame.name)
      .map(([ roleId, _ ]) => roleId);
    if (!roleIds.length) {
      console.log(`No corresponding role found for ${videogame.name}`);
      continue;
    }
    
    const participants = event.entrants.nodes.flatMap(node => node.participants);
    for (const participant of participants) {
      const member = getMemberForParticipant(members, participant);
      if (member) {
        console.log(`Found: ${member.user.tag}`);
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
  }

  // Add roles to members and set nicknames
  await Promise.all(Object.values(playersByDiscordId)
    .map(addRoles));
  await Promise.all(Object.values(playersByDiscordId)
    .map(setNickname));

  discordClient.destroy();
}

function getMemberForParticipant(members, participant) {
  if (participant.user && participant.user.authorizations) {
    const discordTag = participant.user.authorizations[0].externalUsername;
    console.log(`Looking for ${discordTag}`);
    return members.find(m => m.user.tag === discordTag);
  } else {
    // TODO(Adrian): Consider using a string similarity algorithm
    const handle = participant.gamerTag;
    const fullHandle = participant.prefix && `${participant.prefix} | ${participant.gamerTag}`;
    console.log(`Looking for ${fullHandle}`);
    return members.find(m =>
      m.user.username === handle ||
      m.user.username === fullHandle ||
      m.displayName === handle ||
      m.displayName === fullHandle);
  }
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
