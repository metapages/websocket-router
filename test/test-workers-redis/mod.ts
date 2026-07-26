export const checkServerHealth = async (server: string): Promise<boolean> => {
  try {
    const response = await fetch(server);
    return response.status === 200;
  } catch (error) {
    console.error(`Error checking health of server ${server}:`, error);
    return false;
  }
};

export const checkAllServers = async (servers: string[]) => {
  const healthChecks = servers.map(async (server) => {
    const isHealthy = await checkServerHealth(server);
    console.log(`Server ${server} is ${isHealthy ? "healthy" : "unhealthy"}.`);
  });

  await Promise.all(healthChecks);
};

export const connectToWebSocket = (url: string): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const disposers : (() => void)[] = [];
    const cleanup = () => disposers.forEach(dispose => dispose());
    
    const messageHandler = (event :any) => {
      console.log('event.data', event.data);
      if (event.data === "subscribeClient.subscribed") { 
        cleanup();
        resolve(ws);
      }
    }
    
    ws.addEventListener('message', messageHandler);
    disposers.push(() => ws.removeEventListener('message', messageHandler));

    const onopen = () => {
      console.log(`Connected to ${url}`);
    };
    ws.addEventListener("open", onopen);
    disposers.push(() => ws.removeEventListener('open', onopen));
    

    const onerror = (err:any) => {
      console.error(`Error connecting to ${url}:`, err);
      cleanup();
      reject(err);
    };
    ws.addEventListener("error", onerror);
    disposers.push(() => ws.removeEventListener('error', onerror));
      
  });
};

export const createWebSocketConnections = async (urls: string[]) :Promise<WebSocket[]> => {
  const connectionPromises = urls.map(url => connectToWebSocket(url));
  const connections = await Promise.all(connectionPromises);
  console.log('All WebSocket connections are open.');
  return connections;
};


export const waitForSpecificMessage = async (connections: WebSocket[], expectedMessage: string, timeout?:number): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    const receivedMessages = new Map<WebSocket, boolean>();
    
    let resolved = false;
    let timoutHandle: number| undefined;
     
    const disposers : (() => void)[] = [];
    const cleanup = () => {
      disposers.forEach(dispose => dispose());
    }
    
    if (timeout) {
      timoutHandle = setTimeout(() => {
        if (!resolved) {
          cleanup();
          reject(new Error(`Timed out waiting for message ${expectedMessage}.`));
        }
      }, timeout);
    }

    connections.forEach(ws => {
      receivedMessages.set(ws, false);
      
      const messageHandler = (event :any) => {
        console.log('event.data', event.data);
        if (event.data === expectedMessage) {
          if (receivedMessages.get(ws)) {
            // Message received twice on this connection
            cleanup();
            reject(new Error(`Duplicate message received on a connection.`));
          } else {
            receivedMessages.set(ws, true);
            // Check if all connections have received the expected message
            const success = Array.from(receivedMessages.values()).every(received => received);
            if (success) {
              resolved = true;
              if (timoutHandle) {
                clearTimeout(timoutHandle);
              }
              cleanup();
              resolve(success);
            }
          }
        } else {
          // ignore other messages
          // // Different message received
          // cleanup();
          // reject(new Error(`Unexpected message received: ${event.data}`));
        }
      }

      ws.addEventListener('message', messageHandler);
      disposers.push(() => ws.removeEventListener('message', messageHandler));

      const errorHandler = (err:any) => {
        cleanup();
        reject(err);
      };
      ws.addEventListener('error', errorHandler);
      disposers.push(() => ws.removeEventListener('error', errorHandler));
      
    });
  });
}


export const waitWebsocketsToClose = async (connections: WebSocket[], timeout?:number): Promise<void> => {
  return new Promise((resolve, reject) => {
    const closedConnections = new Map<WebSocket, boolean>();

    let timoutHandle: number| undefined;
    
    if (timeout) {
      timoutHandle = setTimeout(() => {
        const allClosed = Array.from(closedConnections.values()).every(closed => closed);
        if (!allClosed) {
          reject(new Error(`Timed out waiting for all connections to close.`));
        }
      }, timeout);
    }
    
    const checkIfAllClosed = () => {
      const allClosed = Array.from(closedConnections.values()).every(closed => closed);
      if (allClosed) {
        if (timoutHandle) {
          clearTimeout(timoutHandle);
        }
        resolve();
      }
    }

    connections.forEach(ws => {
      closedConnections.set(ws, false);

      ws.addEventListener('close', (event) => {
        closedConnections.set(ws, true);
        checkIfAllClosed();
      });

      ws.addEventListener('error', (err) => {
        reject(err);
      });
    });
    
    connections.forEach(ws => ws.close());
    
    
  });
}