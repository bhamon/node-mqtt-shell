'use strict';

const fs = require('fs');
const ajv = require('ajv');
const minimist = require('minimist');
const pino = require('pino');
const uuid = require('uuid');
const mqtt = require('mqtt');
const pty = require('node-pty');

const PATTERN_UUID = '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}';

const VALIDATOR_ARGS = new ajv.default({useDefaults: true}).compile({
  type: 'object',
  properties: {
    help: {type: 'boolean', default: false},
    url: {type: 'string', pattern: 'mqtts?://.*'},
    ['client-id']: {type: 'string'},
    username: {type: 'string'},
    password: {type: 'string'},
    cert: {type: 'string'},
    key: {type: 'string'},
    ca: {type: 'string'},
    prefix: {type: 'string', default: ''},
    id: {
      type: 'string',
      pattern: PATTERN_UUID,
      default: uuid.v4()
    },
    shell: {type: 'string', default: 'bash'},
    level: {
      type: 'string',
      enum: ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'],
      default: 'info'
    }
  },
  required: ['help', 'url', 'prefix', 'id', 'shell', 'level']
});

const VALIDATOR_CREATE = new ajv.default().compile({
  type: 'object',
  properties: {
    id: {
      type: 'string',
      pattern: PATTERN_UUID
    }
  }
});

const VALIDATOR_REMOVE = new ajv.default().compile({
  type: 'object',
  properties: {
    id: {
      type: 'string',
      pattern: PATTERN_UUID
    }
  }
});

function printUsage() {
  console.log(`
NAME
  target.js

SYNOPSIS
  node target.js -m <URL> -t <PREFIX>

DESCRIPTION
  Exposes local shells to remote clients through an MQTT intermediary broker.

  -h, --help
    Show this help message.
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
  -i, --id=<ID>
    Target ID.
    Defaults to a uniquely generated one.
  -s, --shell=<SHELL>
    Shell executable to spawn.
    Defaults to 'bash'.
  -l, --level=<LEVEL>
    Log level.
    One of ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'].
    Defaults to 'info'.
  `);
}

const args = minimist(process.argv.slice(2), {
  boolean: ['help'],
  string: [
    'url',
    'client-id',
    'username',
    'password',
    'cert',
    'key',
    'ca',
    'prefix',
    'id',
    'shell',
    'level'
  ],
  alias: {
    h: 'help',
    m: 'url',
    c: 'client-id',
    u: 'username',
    p: 'password',
    t: 'prefix',
    i: 'id',
    s: 'shell',
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
const mqttConfig = {};

log.info({targetId: args.id});

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

const shells = new Map();
const mqttClient = mqtt.connect(args.url, mqttConfig);

const topic = `${args.prefix}${args.id}`;
const topicList = `${topic}/list`;
const topicCreate = `${topic}/create`;
const topicRemove = `${topic}/remove`;

function ttyList() {
  mqttClient.publish(topicList, JSON.stringify([...shells.keys()]), {qos: 1/*, retain: true*/});
}

function ttyCreate(_msg) {
  const slog = log.child({method: 'tty.create'});
  const params = JSON.parse(_msg);
  if (!VALIDATOR_CREATE(params)) {
    slog.error({errors: VALIDATOR_CREATE.errors}, 'invalid params');
    return;
  }

  if (shells.has(params.id)) {
    slog.warn({id: params.id}, 'shell already exists');
    return;
  }

  slog.info({id: params.id});

  const shell = {};

  shell.process = pty.spawn(args.shell, [], {
    name: 'xterm-color',
    cols: 120,
    rows: 50,
    env: process.env
  });

  const topicTty = `${topic}/${params.id}`;
  const topicTtyIn = `${topicTty}/in`;
  const topicTtyOut = `${topicTty}/out`;

  shell.process.onExit(() => {
    mqttClient.unsubscribe(topicTtyIn);
    mqttClient.off('message', shell.onMessage);

    shells.delete(params.id);

    ttyList();
  });

  let seqIn = 0;
  let seqOut = 0;
  let bufferIn = [];

  shell.onMessage = (_topic, _msg) => {
    if (_topic !== topicTtyIn) {
      return;
    }

    const packet = JSON.parse(_msg);
    bufferIn.push(packet);
    bufferIn.sort((p1, p2) => p1.seq - p2.seq);

    while (bufferIn.length && bufferIn[0].seq === seqIn) {
      shell.process.write(bufferIn.shift().data);
      ++seqIn;
    }
  };

  shell.process.onData(_data => {
    const packet = {
      seq: seqOut++,
      data: _data
    };

    mqttClient.publish(topicTtyOut, JSON.stringify(packet));
  });

  mqttClient.subscribe(topicTtyIn);
  mqttClient.on('message', shell.onMessage);

  shells.set(params.id, shell);

  ttyList();
}

function ttyRemove(_msg) {
  const slog = log.child({method: 'tty.remove'});
  const params = JSON.parse(_msg);
  if (!VALIDATOR_REMOVE(params)) {
    slog.error({errors: VALIDATOR_REMOVE.errors}, 'invalid params');
    return;
  }

  const shell = shells.get(params.id);
  if (!shell) {
    slog.warn({id: params.id}, 'shell does not exist');
    return;
  }

  slog.info({id: params.id});

  shell.process.kill(9);
}

mqttClient.on('error', e => log.error({err: e}));

mqttClient.on('connect', () => {
  ttyList();

  mqttClient.subscribe(topicCreate);
  mqttClient.subscribe(topicRemove);
});

mqttClient.on('message', (_topic, _msg) => {
  switch (_topic) {
    case topicCreate:
      ttyCreate(_msg);
      break;
    case topicRemove:
      ttyRemove(_msg);
      break;
  }
});
