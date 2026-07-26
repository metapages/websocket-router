import {
  cryptoRandomString,
} from 'https://deno.land/x/crypto_random_string@1.0.0/mod.ts';

import {
  SERVER_INSTANCE_ID,
  SERVER_INSTANCE_ID_LENGTH,
} from './id.ts';
import {
  publishClient,
  subscribeClient,
} from './redis/client.ts';

const sockets: Map<string, WebSocket[]> = new Map();


export const sendToAll = (key: string, message: string) => {

  // redis pubsub. this is async, but we aren't waiting for it
  // the server key is prepended so we filter it out when it comes back
  sendToRedis(key, message);

  // messagesSinceLastLog++;
  const socketArray = sockets.get(key);
  // console.log(`sendToAll socketArray.length=${socketArray.length} message=${message.substring(0, 50)}`)
  if (socketArray) {
    for (let i = 0; i < socketArray.length; i++) {
      if (socketArray[i].readyState === WebSocket.OPEN) {
        socketArray[i].send(message);
      } else {
        console.log(`[key=${key}] 🐋🐋🐋 ws: sendToAll: socketArray[${i}].readyState !== WebSocket.OPEN`, message);
      }
    }
  }
}

export const handleWebsocketConnection = (
  socket: WebSocket,
  request: Request,
) => {
  const urlBlob = new URL(request.url);

  const urlTokens = urlBlob.pathname.split("/");

  const key = urlTokens[urlTokens.length - 1]; // less the initial '/'
  if (key.length < 6) {
    console.log(`🐋 ws: closing and returning because invalid key: ${key}`);
    socket.close();
    return;
  }

  const disposers: (() => void)[] = [];

  const wsConnectionId = cryptoRandomString({
    length: 4,
    type: "alphanumeric",
  });
  const logPrefix = `🐋 ws-${wsConnectionId}[key=${key}]: `;
  
  if (!sockets.has(key)) {
    sockets.set(key, []);
  }
  const socketArray = sockets.get(key)!;
  socketArray.push(socket);

  
  let messagesSinceLastLog = 0;

  const sendToOthers = (message: string) => {

    // redis pubsub. this is async, but we aren't waiting for it
    // the server key is prepended so we filter it out when it comes back
    sendToRedis(key, message);

    messagesSinceLastLog++;
    for (let i = 0; i < socketArray.length; i++) {
      if (socketArray[i] !== socket) {
        if (socketArray[i].readyState === WebSocket.OPEN) {
          socketArray[i].send(message);
        }
      }
    }
  }


  // websocket input messages are sent to OTHER websocket connections
  // and to redis (that connects all other channel instances)
  socket.addEventListener("message", ({ data }: { data: string }) => {
    if (data.startsWith("ping")) {
      socket.send("client ping: pong from server");
      return;
    }
    console.log(`[${key}, ${wsConnectionId}] socket message`, data.substring(0, 500));
    // Do not respond to subscribed messages that WE sent
    if (data.startsWith(SERVER_INSTANCE_ID)) {
      // console.log(`[${key}, ${wsConnectionId}] socket ignored because data.startsWith(SERVER_INSTANCE_ID)`);
      return;
    }

    // const messageLessPrefix = data.startsWith('{') ? data : data.substring(
    //   SERVER_INSTANCE_ID_LENGTH + 1,
    // );

    sendToOthers(data);
  });

  let closed = false;

  // Handle the redis pubsub
  const subscriptionHandler = (message: string, channel: string) => {
    // console.log(`${logPrefix} 🐋🐋🐋 ws: subscription message recieved: ${message} closed=${closed} channel=${channel}`);
    if (closed) return;
    if (channel !== key) return;
    // Do not respond to subscribued messages that WE sent
    if (message.startsWith(SERVER_INSTANCE_ID)) return;

    // recieved messages are always from other servers, and thus always 
    // have the message prefixed with the server instance id
    const messageLessServerId = message.substring(
      SERVER_INSTANCE_ID_LENGTH + 1,
    );

    // This aspect is not fully tested, multiple models, multiple clients, etc.
    for (let i = 0; i < socketArray.length; i++) {
      // console.log(`${logPrefix} 🐋🐋🐋 ws: redis subscription message sending downstream: ${messageLessServerId} closed=${closed} socketArray[${i}].readyState === WebSocket.OPEN=${socketArray[i].readyState === WebSocket.OPEN}`);
      if (socketArray[i].readyState === WebSocket.OPEN) {
        socketArray[i].send(messageLessServerId);
      }
    }
  };


  const unsubscribeRedis = async () => {
    await subscribeClient.unsubscribe(key, subscriptionHandler);
    // console.log(`${logPrefix} 🐋🐋🐋 🚫 unsubscribed redis 👍 `);
  };



  const closeAllResources = () => {
    console.log(`${logPrefix} 🐋🐋🐋 🚫 closeAllResources`);
    if (closed) {
      return;
    }
    try {
      unsubscribeRedis();
    } catch (_) {
      // ignored
    }
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
    closed = true;
    socketArray.splice(socketArray.indexOf(socket), 1);
    console.log(`- ${key} (${socketArray.length})`);
  }

  socket.addEventListener("close", closeAllResources);
  // console.log(`${logPrefix} ✅✅✅ listening to close events`);

  socket.addEventListener("error", (e: any) => {
    console.log(`${logPrefix} socket errored: ${e.message}`);
    closeAllResources();
  });

  subscribeClient.subscribe(key, subscriptionHandler).then(() => {
    if (socket.readyState === WebSocket.OPEN) {
      // socket.send("subscribeClient.subscribed");
    }
  });
};

export const sendToRedis = async (channel: string, message: string) => {
  await publishClient.publish(channel, SERVER_INSTANCE_ID + ":" + message);
};
