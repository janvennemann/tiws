# tiws: a Titanium WebSocket library

Pure JavaScript based WebSocket client implementation for Titanium using [Ti.Network.Socket.TCP](https://appcelerator.github.io/titanium-docs/api/titanium/network/socket/tcp.html). Can be used as a repalcement for [ws](https://github.com/websockets/ws) on Titanium.

## Install

```sh
npm i tiws
```

```sh
yarn add tiws
```

## Usage

```js
const WebSocket = require('tiws');

const ws = new WebSocket('ws://www.host.com/path');

ws.on('open', function open() {
  ws.send('something');
});

ws.on('message', function incoming(data) {
  console.log(data);
});
```

For more example see the [usage examples](https://github.com/websockets/ws#usage-examples ) of the original [ws](https://github.com/websockets/ws) module.

## Known Limitations

This module is heavily inspired by `ws` but is missing a few features since Titanium is not a full NodeJS compatible enviornment.

- `tiws` only works as a WebSocket client. `WebSocket.Server` functionaily was not ported yet.
- No support for secure WebSocket connections (`wss:`) yet. If you need this head over to [titanium_mobile#11137](https://github.com/appcelerator/titanium_mobile/pull/11137) and upvote that issue so it receives more visibility.
- Extended payload length of 64-bit integer not supported yet.
- `PerMessageDeflate` extensions is not supported. There is no zip implementation available in Titanium to handle the (de)compression.
