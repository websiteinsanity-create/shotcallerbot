# Shotcaller User Guide

## Start

Join the command voice channel and run:

/shotcaller start

Choose:
- GvG — 8 parties
- Full Guild — 12 parties
- Bridge — 8 parties plus bridge controls
- Custom — enter 1–12

The bot creates party voice channels and the control panel.

## Panel

The panel displays:
- party channels
- audio state
- music state
- dedicated caller
- bridge state
- whisper assignments

### Mute

Stops the Shotcaller voice broadcast without ending the session.

### Dedicated

Select one member of the command voice channel. Only that user's voice is broadcast.

Select Dedicated again to clear the dedicated caller.

### Music

Select a configured track.

Music loops until stopped or changed.

If the music process fails, select Stop Music and start the track again.

### Whisper Setup

Party 1 is automatically:
  Everyone

For Party 2–12, select one member of that party as the whisperer.

That person's voice is routed to the Shotcaller instead of the other parties.

The assignment is cleared when the session ends.

### Stop

Stops voice connections and deletes the generated party channels.

## Whisper behavior

Party 1:
  Any member speaking may be routed to the Shotcaller.

Party 2–12:
  Only the assigned whisperer is routed to the Shotcaller.

Whispers are not broadcast to the other parties.

## Bridge

Both guilds must have an active session and be configured as partners.

Click Bridge on one side.
The other side must accept.

Once active, only the selected live guild sends its Shotcaller audio to both sides.

Click the live-side control to switch sides.

Stopping a session ends its bridge state.
