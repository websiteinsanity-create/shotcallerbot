# Discord setup

## Main bot

Create a Discord application and bot user.

Invite it with these permissions:
- View Channels
- Send Messages
- Embed Links
- Manage Channels
- Connect
- Speak
- Use Voice Activity

Gateway intents:
- Guilds
- Guild Members
- Guild Voice States

## Relay bots

Create one relay bot application per simultaneous party channel, up to 12.

Invite every relay bot to every guild where it will be used.

Relay permissions:
- View Channels
- Connect
- Speak
- Use Voice Activity

The relay bot must be able to see and join the generated party channels.

## Tokens

Put the main bot token in:
MAIN_BOT_TOKEN=

Put relay tokens in order:
RELAY_BOT_TOKENS=relay1,relay2,...,relay12

Do not share these tokens.
If a token is exposed, regenerate it in the Discord Developer Portal.

## Roles

Create a Shotcaller role. Optionally create Officer and Leader roles.

By default:
- Shotcaller can start/control sessions.
- Officer/Leader can use bridge controls.
- Administrator can control everything.
