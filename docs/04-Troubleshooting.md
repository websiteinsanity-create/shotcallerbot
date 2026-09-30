# Troubleshooting

## Slash command does not appear

If DEV_GUILD_ID is set, restart the bot after changing commands.
For global registration, Discord propagation can take time.

## Relay bot does not join

Check:
- relay token is correct
- relay bot is invited to the guild
- relay bot can see the generated channels
- relay bot has Connect and Speak
- relay token order matches the party number

## No voice audio

Check:
- main bot is in the command voice channel
- main bot has Connect/Speak
- Guild Voice States intent is enabled
- users are actually transmitting voice
- test in a private server

## Music does not play

Check:
- FFmpeg is installed (or use Docker)
- source path exists
- source is a readable audio file
- select Stop Music, then select the track again

## Whisper does not arrive

Check:
- Party 1 or an assigned whisperer is speaking
- the assigned user is actually in that party
- relay/main bots have voice permissions
- no session mute is active

## Bridge does not work

Check:
- both guild IDs are mapped in BRIDGE_PARTNERS
- both guilds have active sessions
- the same relay bot accounts are invited to both guilds
- both sides are using the same running application instance

For cross-host bridge deployments, use a private network/transport layer; do not expose the bridge secret publicly.
