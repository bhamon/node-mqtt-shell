# MQTT shell

A simple and effective shell piping through an MQTT broker.

## Target

A target is identified with an unique UUID and exposes three topics to the provided MQTT broker:
- `list`: this topic exposes the virtual TTY list currently in use on the target.
- `create`: creates a new virtual TTY.
- `remove`: removes a virtual TTY.

The `create` and `remove` topics expect a JSON-encoded message:
```json
{
  "id": "00000000-0000-0000-0000-000000000000"
}
```

With:
- `id`: an unique UUID.

Once created, the virtual TTY is exposed to the MQTT broker:
- `<ID>/in`: TTY input stream (from master to target).
- `<ID>/out`: TTY output stream (from target to master).

Those topics expose JSON-encoded messages:
```json
{
  "seq": 0,
  "data": "xxxx"
}
```

With:
- `seq`: message sequence number for ordering purposes.
- `data`: utf8-encoded raw stream data.

### Run

To run the target server use the following command:

```shell
node lib/target.js -h
```

See the command options for more information.

## Master

The master instance is a WS server that proxies messages from an xterm.js client to the specified target through the provided MQTT broker.

A `target` search param must be provided in the WS client connection URL.

### Run

To run the master server use the following command:

```shell
node lib/master.js -h
```

See the command options for more information.

Once launched, you can use the `ui/master-client.html` web page to open a terminal to a target.