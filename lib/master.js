'use strict';

const fs = require('fs');
const ajv = require('ajv');
const minimist = require('minimist');
const pino = require('pino');
const ws = require('ws');
const mqtt = require('mqtt');
const uuid = require('uuid');

const PATTERN_UUID = '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const HEARTBEAT_INTERVAL = 30000;

const VALIDATOR_ARGS = new ajv.default({useDefaults: true}).compile({
  type: 'object',
  properties: {
    help: {type: 'boolean', default: false},
    port: {type: 'number', minimum: 1, maximum: 65535},
    host: {type: 'string'},
    url: {type: 'string', pattern: 'mqtts?://.*'},
    ['client-id']: {type: 'string'},
    username: {type: 'string'},
    password: {type: 'string'},
    cert: {type: 'string'},
    key: {type: 'string'},
    ca: {type: 'string'},
    prefix: {type: 'string', default: ''},
    shell: {type: 'string', default: 'bash'},
    level: {
      type: 'string',
      enum: ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'],
      default: 'info'
    }
  },
  required: ['help', 'url', 'prefix', 'shell', 'level']
});

const VALIDATOR_TARGET = new ajv.default().compile({
  type: 'string',
  pattern: PATTERN_UUID
});

function printUsage() {
  console.log(`
NAME
  master.js

SYNOPSIS
  node master.js -b <PORT> -m <URL> -t <PREFIX>

DESCRIPTION
  Exposes a WS server to grab remote shells through an MQTT intermediary broker.
  The WS server can be used by an XTerm.js compliant client.
  To connect to the proper target, a 'target' query param must be specified upon connection.

  -h, --help
    Show this help message.
  -b, --port=<PORT>
    WS server binding port.
  -o, --host=<HOST>
    WS server binding host.
  -m, --url=<URL>
    Intermediary MQTT broker URL.
  -c, --client-id=<CLIENT_ID>
    MQTT client id.
    Defaults to a randomly generated one.
  -u, --username=<USERNAME>
    MQTT user name, if any.
  -p, --password=<PASSWORD>
    MQTT password, if any.
  --cert=<CERT>
    Path to the client certificate (PEM format).
    Only used for MQTTS enabled brokers.
  --key=<KEY>
    Path to the client private key (PEM format).
    Only used for MQTTS enabled brokers.
  --ca=<CA>
    Path to the CA certificate (PEM format).
    Only used for MQTTS enabled brokers.
  -t, --prefix=<PREFIX>
    MQTT topic prefix (with trailing slash).
    Defaults to ''.
  -l, --level=<LEVEL>
    Log level.
    One of ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'].
    Defaults to 'info'.
  `);
}

const args = minimist(process.argv.slice(2), {
  boolean: ['help'],
  strings: [
    'port',
    'host',
    'url',
    'client-id',
    'username',
    'password',
    'cert',
    'key',
    'ca',
    'prefix',
    'level'
  ],
  alias: {
    h: 'help',
    b: 'port',
    o: 'host',
    m: 'url',
    c: 'client-id',
    u: 'username',
    p: 'password',
    t: 'prefix',
    l: 'level'
  }
});

if (args.help) {
  printUsage();
  return;
}

if (!VALIDATOR_ARGS(args)) {
  printUsage();
  console.error(JSON.stringify(VALIDATOR_ARGS.errors));
  process.exitCode = 1;
  return;
}

const log = pino({level: args.level});
const wsServerConfig = {
  port: args.port
};
const mqttConfig = {};

if (args.host) {
  wsServerConfig.host = args.host;
}

if (args['client-id']) {
  mqttConfig.clientId = args['client-id'];
}

if (args.username) {
  mqttConfig.username = args.username;
}

if (args.password) {
  mqttConfig.password = args.password;
}

if (args.url.startsWith('mqtts://')) {
  if (args.cert) {
    mqttConfig.cert = fs.readFileSync(args.cert);
  }

  if (args.key) {
    mqttConfig.key = fs.readFileSync(args.key);
  }

  if (args.ca) {
    mqttConfig.ca = fs.readFileSync(args.ca);
  }
}

const wsServer = new ws.Server(wsServerConfig);
const mqttClient = mqtt.connect(args.url, mqttConfig);

wsServer.on('error', e => log.error({err: e}));
mqttClient.on('error', e => log.error({err: e}));

wsServer.on('connection', (_wsClient, _request) => {
  const url = new URL(_request.url, `http://${_request.headers.host}`);
  const targetId = url.searchParams.get('target');
  if (!VALIDATOR_TARGET(targetId)) {
    log.error({targetId}, 'invalid target id');
    _wsClient.close();
    return;
  }

  const ttyId = uuid.v4();
  const slog = log.child({ttyId});

  slog.info({targetId}, 'connected');

  const topic = `${args.prefix}${targetId}`;
  const topicCreate = `${topic}/create`;
  const topicRemove = `${topic}/remove`;

  mqttClient.publish(topicCreate, JSON.stringify({id: ttyId}), {qos: 1});

  const topicTty = `${topic}/${ttyId}`;
  const topicTtyIn = `${topicTty}/in`;
  const topicTtyOut = `${topicTty}/out`;

  _wsClient.on('error', e => slog.error({err: e}));

  let isAlive = true;
  _wsClient.on('pong', () => isAlive = true);

  const heartbeat = setInterval(() => {
    if (!isAlive) {
      _wsClient.terminate();
      return;
    }

    isAlive = false;
    _wsClient.ping();
  }, HEARTBEAT_INTERVAL);

  let seqIn = 0;
  let seqOut = 0;
  let bufferOut = [];

  function onMessage(_topic, _msg) {
    if (_topic !== topicTtyOut) {
      return;
    }

    const packet = JSON.parse(_msg);
    bufferOut.push(packet);
    bufferOut.sort((p1, p2) => p1.seq - p2.seq);

    while (bufferOut.length && bufferOut[0].seq === seqOut) {
      _wsClient.send(bufferOut.shift().data);
      ++seqOut;
    }
  }

  _wsClient.on('message', _msg => {
    const packet = {
      seq: seqIn++,
      data: _msg
    };

    mqttClient.publish(topicTtyIn, JSON.stringify(packet));
  });

  mqttClient.subscribe(topicTtyOut);
  mqttClient.on('message', onMessage);

  _wsClient.on('close', () => {
    slog.info('disconnected');

    clearInterval(heartbeat);

    mqttClient.unsubscribe(topicTtyOut);
    mqttClient.off('message', onMessage);
    mqttClient.publish(topicRemove, JSON.stringify({id: ttyId}), {qos: 1});
  });
});
