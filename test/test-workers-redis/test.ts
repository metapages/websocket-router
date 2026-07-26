import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.209.0/assert/mod.ts';

import {
  checkAllServers,
  createWebSocketConnections,
  waitForSpecificMessage,
  waitWebsocketsToClose,
} from './mod.ts';

// Testing the redis connected data streams
const server1Address = `deno-service1:3000`;
const server2Address = `deno-service2:3000`;
const server3Address = `deno-service3:3000`;

const servers = [server1Address, server2Address, server3Address];
const wsServers = servers.map((server) => `ws://${server}`);

await checkAllServers(servers.map((server) => `http://${server}/healthcheck`));
console.log("🚀 All servers ready")

// The actual tests


Deno.test("Websocket channel messages distributed via redis", async () => {
  const url = new URL("./foo.js", "https://deno.land/");
  assertEquals(url.href, "https://deno.land/foo.js");
  
  console.log("Test 1:")
  // Test 1: shoot a message //
  const message1 = "hello world " + Math.random();
  const message2 = "hello world " + Math.random();
  // Make three websocket connections, and send a message to one of them
  const channel1 = "test1";
  const wsConnections = await createWebSocketConnections(wsServers.map((server) => `${server}/${channel1}`));

  // await delay(5000);

  setTimeout(() => {
    console.log("sending message 1")
    wsConnections[0].send(message1);
    
  }, 2000);
  

  // console.log("Waiting for message")
  const success1 = await waitForSpecificMessage(wsConnections.slice(1), message1, 5000);
  // console.log("GOT ALL MESSAGES1")
  
  setTimeout(() => {
    console.log("sending message 2")
    wsConnections[0].send("nothing");
    wsConnections[0].send(message2);
  }, 2000);
  const success2 = await waitForSpecificMessage(wsConnections.slice(1), message2, 5000);
  // console.log("GOT ALL MESSAGES2")
  
  
  assert(success1);
  assert(success2);
  // console.log("GOT ALL MESSAGES")
  
  await waitWebsocketsToClose(wsConnections, 5000);

  // console.log("Ran tests!!")

});
