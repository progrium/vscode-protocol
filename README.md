# Unofficial VSCode Protocol Explainer + Decoder

This tool decodes communication between the VSCode frontend and backend (like a protocol specific Wireshark). I also describe what I've learned about the protocol below since it is otherwise undocumented. From here, one could use this tool and knowledge to implement an alternative backend to the VSCode frontend. If for some reason you're interested in this, please let me know.

## Using the decoder

You need Docker and Go to use this tool. Clone this repo and then run:
```
make setup
```
This will install Go dependencies and clone the VSCode source repository into this project directory, which is used by the decoder. Now we'll run the [gitpod/openvscode-server](https://github.com/gitpod-io/openvscode-server) Docker container, which runs VSCode outside of Electron allowing you to run it in the browser:
```
docker run -it --init -p 3000:3000 -v "$(pwd):/home/workspace:cached" gitpod/openvscode-server
```
This will listen on port 3000, which is important. Test it if you want, but we're now going to run a proxy in front of it on port 8000:
```
make dev
```
Now you can reach VSCode in the browser at localhost:8000, which proxies to localhost:3000 while intercepting WebSocket packets and running them through the decoder to log human-readable JSON messages to the console. Payloads that are very large are truncated to 1024 bytes in this view.

## How VSCode works

VSCode started as an Electron app, which lets you build a web frontend that runs in a webview in a native window. The app can also have a "backend" which is Node.js code running in the background that has an extended runtime for doing native desktop things. Eventually people figured out how to patch the backend to run outside of Electron as a standalone server that would serve the frontend to a browser, which is where projects like openvscode-server come from. Eventually, VSCode upstreamed some of these patches to support the browser use-case as well as using this frontend/backend protocol to implement remoting features like [Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels). I haven't confirmed this, but I suspect these remoting features are done by tunneling connections to a different backend that can speak the same protocol used between frontend and backend. 

### Protocol Overview

Once the frontend is loaded in the browser or webview, two WebSocket connections are established to the backend that served it. You can see status updates on these connections in the DevTools console. One is referred to as "renderer-Management" and "renderer-ExtensionHost". The "renderer" part I suspect is a holdover from Electron terminology of the [renderer process](https://www.electronjs.org/docs/latest/tutorial/process-model) representing the process running the webview. Electron would provide its own IPC to communicate between the "main" Node.js process and the "renderer" webview processes. VSCode's protocol works over this IPC mechanism, over Node.js sockets, and over WebSockets using a common message wire protocol, and then a different higher level protocol on top of this.

The "management" connection uses the message wire protocol, and then a "channel service" protocol to talk about mostly UI state changes. Similar to Electron IPC between main and renderer processes, this lets the webview/browser get events when there are window resizes, focus changes, etc, but also general inqueries like what extensions are installed. Even though it's not called RPC, it still have very RPC-like semantics as well as event subscriptions. 

The "extension host" connection uses the message wire protocol, and then a bi-directional RPC protocol to communicate with the VSCode specific process running extensions. This is how the frontend interacts with extensions and lets extensions interact with the frontend. However, many "core" features of VSCode are run as extensions, such as git support. 

### Message Wire Protocol

In VSCode, a network socket (Node.js TCP socket or WebSocket) is abstracted as an [ISocket](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/ipc/common/ipc.net.ts#L145). In these cases a message-based wire protocol is implemented. [Here](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/ipc/common/ipc.net.ts#L257) is the enum of message types:
```ts
const enum ProtocolMessageType {
	None = 0,
	Regular = 1,
	Control = 2,
	Ack = 3,
	Disconnect = 5,
	ReplayRequest = 6,
	Pause = 7,
	Resume = 8,
	KeepAlive = 9
}
```
This gives you an idea of what's done at this level. Flow control, keep-alives, etc. Messages of type Regular bubble up to the next protocol layer. But real quick, here is a diagram of these wire protocol message frames from the VSCode docs:
```ts
/**
 * A message has the following format:
 * ```
 *     /-------------------------------|------\
 *     |             HEADER            |      |
 *     |-------------------------------| DATA |
 *     | TYPE | ID | ACK | DATA_LENGTH |      |
 *     \-------------------------------|------/
 * ```
 * The header is 9 bytes and consists of:
 *  - TYPE is 1 byte (ProtocolMessageType) - the message type
 *  - ID is 4 bytes (u32be) - the message id (can be 0 to indicate to be ignored)
 *  - ACK is 4 bytes (u32be) - the acknowledged message id (can be 0 to indicate to be ignored)
 *  - DATA_LENGTH is 4 bytes (u32be) - the length in bytes of DATA
 *
 * Only Regular messages are counted, other messages are not counted, nor acknowledged.
 */
```

### Managament / Channel Protocol

This request/reply protocol is made around an abstraction of a "channel", which is a collection of commands and source of events. The API for channels look like [this](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/ipc/common/ipc.ts#L24):
```ts
export interface IChannel {
	call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T>;
	listen<T>(event: string, arg?: any): Event<T>;
}
```
This is implemented with request and response messages of various types. [Here](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/ipc/common/ipc.ts#L39) are the enums for these message types:
```ts
const enum RequestType {
	Promise = 100,
	PromiseCancel = 101,
	EventListen = 102,
	EventDispose = 103
}

const enum ResponseType {
	Initialize = 200,
	PromiseSuccess = 201,
	PromiseError = 202,
	PromiseErrorObj = 203,
	EventFire = 204
}
```
Within a Regular wire message, this protocol uses frames of several "buffer" types to encode data. [Here](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/ipc/common/ipc.ts#L236C1-L244C2) are those types:
```ts
enum DataType {
	Undefined = 0,
	String = 1,
	Buffer = 2,
	VSBuffer = 3,
	Array = 4,
	Object = 5,
	Int = 6
}
```
A message could contain several of these values, which are all length-prefixed using [VRQ](https://en.wikipedia.org/wiki/Variable-length_quantity). Just to give you an idea of how these are values are read/written on the wire (within a Regular message frame), here are the [serialize](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/ipc/common/ipc.ts#L265) and [deserialize](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/ipc/common/ipc.ts#L301C1-L322C2) functions:
```ts
export function serialize(writer: IWriter, data: any): void {
	if (typeof data === 'undefined') {
		writer.write(BufferPresets.Undefined);
	} else if (typeof data === 'string') {
		const buffer = VSBuffer.fromString(data);
		writer.write(BufferPresets.String);
		writeInt32VQL(writer, buffer.byteLength);
		writer.write(buffer);
	} else if (hasBuffer && Buffer.isBuffer(data)) {
		const buffer = VSBuffer.wrap(data);
		writer.write(BufferPresets.Buffer);
		writeInt32VQL(writer, buffer.byteLength);
		writer.write(buffer);
	} else if (data instanceof VSBuffer) {
		writer.write(BufferPresets.VSBuffer);
		writeInt32VQL(writer, data.byteLength);
		writer.write(data);
	} else if (Array.isArray(data)) {
		writer.write(BufferPresets.Array);
		writeInt32VQL(writer, data.length);

		for (const el of data) {
			serialize(writer, el);
		}
	} else if (typeof data === 'number' && (data | 0) === data) {
		// write a vql if it's a number that we can do bitwise operations on
		writer.write(BufferPresets.Uint);
		writeInt32VQL(writer, data);
	} else {
		const buffer = VSBuffer.fromString(JSON.stringify(data));
		writer.write(BufferPresets.Object);
		writeInt32VQL(writer, buffer.byteLength);
		writer.write(buffer);
	}
}

export function deserialize(reader: IReader): any {
	const type = reader.read(1).readUInt8(0);

	switch (type) {
		case DataType.Undefined: return undefined;
		case DataType.String: return reader.read(readIntVQL(reader)).toString();
		case DataType.Buffer: return reader.read(readIntVQL(reader)).buffer;
		case DataType.VSBuffer: return reader.read(readIntVQL(reader));
		case DataType.Array: {
			const length = readIntVQL(reader);
			const result: any[] = [];

			for (let i = 0; i < length; i++) {
				result.push(deserialize(reader));
			}

			return result;
		}
		case DataType.Object: return JSON.parse(reader.read(readIntVQL(reader)).toString());
		case DataType.Int: return readIntVQL(reader);
	}
}
```
However most communication in this protocol follows a common structure: a header array value, and an optional body value. The first element of the header array is the type, either request type or response type ID from the enums above. Promise and EventListen requests structured like this:
```
[request.type, request.id, request.channelName, request.name], request.arg
```
The header array has type, an ID, channelName, and command name. The value after the header is typically an object of parameters for this command. As you can see this is very RPC-like. Cancel and EventDispose requests are just header arrays like this:
```
[request.type, request.id]
```
All response types are structured with a similar header array and data value:
```
[response.type, response.id], response.data
```
Except for the Initialize response, which is just a single value array header with the type and no value:
```
[response.type]
```
Here are some examples from the decoder:
```
Management-f484a7179266 >> req [100,47,"remoteFilesystem","watch"] ["f9de39c2-75bb-457d-8d2d-2a9e59aea4fd","18884a28-c4ca-4832-b010-9c1fcdb4d23b",{"$mid":1,"external":"vscode-remote://localhost:8000/home/workspace/.openvscode-server/data/Machine","path":"/home/workspace/.openvscode-server/data/Machine","scheme":"vscode-remote","authority":"localhost:8000"},{"recursive":false,"excludes":[]}]
```
This is a Promise request (100) sent from the frontend to the backend. After "req" you can see the header array, and then after that you can see the argument payload value. 
```
Management-f484a7179266 << event [204,36] {"id":1,"event":{"pid":20405,"cwd":"/home/workspace"}}
```
This is a event fire response (204). Again, header array with type and correlating req ID, then the event data, an object.

As you can imagine, you can use the request header data to grab a command name (they often start with a $) and search against the VSCode codebase to find the implementation with TypeScript type data. If you're lucky there may be comments, but often not. By following all the types, you should have enough information from the names. 

### Extension Host / RPC Protocol

This protocol is much more explicitly an RPC protocol but is structured a bit differently. Within a Regular type wire message frame, these frames are binary structures differing depending on the type, found in the first byte. [Here](https://github.com/microsoft/vscode/blob/1813b35895c3aeb2047f162207c31ba9ec351a04/src/vs/workbench/services/extensions/common/rpcProtocol.ts) is the enum of possible values:
```ts
const enum MessageType {
	RequestJSONArgs = 1,
	RequestJSONArgsWithCancellation = 2,
	RequestMixedArgs = 3,
	RequestMixedArgsWithCancellation = 4,
	Acknowledged = 5,
	Cancel = 6,
	ReplyOKEmpty = 7,
	ReplyOKVSBuffer = 8,
	ReplyOKJSON = 9,
	ReplyOKJSONWithBuffers = 10,
	ReplyErrError = 11,
	ReplyErrEmpty = 12,
}
```
You can see there are bunch of different ways to send both requests and replies, plus acknowledged and cancel types. Most of the variations are based on the data types of the arguments or response value. Although still not entirely revealing, we can get an idea of the other types besides JSON from the [ArgType](https://github.com/microsoft/vscode/blob/1813b35895c3aeb2047f162207c31ba9ec351a04/src/vs/workbench/services/extensions/common/rpcProtocol.ts#L955C1-L960C2) enum and [MixedArg](https://github.com/microsoft/vscode/blob/1813b35895c3aeb2047f162207c31ba9ec351a04/src/vs/workbench/services/extensions/common/rpcProtocol.ts#L963) type:
```ts
const enum ArgType {
	String = 1,
	VSBuffer = 2,
	SerializedObjectWithBuffers = 3,
	Undefined = 4,
}

type MixedArg =
	| { readonly type: ArgType.String; readonly value: VSBuffer }
	| { readonly type: ArgType.VSBuffer; readonly value: VSBuffer }
	| { readonly type: ArgType.SerializedObjectWithBuffers; readonly value: VSBuffer; readonly buffers: readonly VSBuffer[] }
	| { readonly type: ArgType.Undefined }
```
Luckily this is all normalized in the decoder output, as here are some examples:
```
ExtensionHost-fd66c8d63f16 << req-json-args 27 [33,"$initializeExtensionStorage",[true,"vscode.git"],false]
ExtensionHost-fd66c8d63f16 << req-json-args 28 [33,"$initializeExtensionStorage",[false,"vscode.git"],false]
ExtensionHost-fd66c8d63f16 >> rep-ok-json 27 "{}"
ExtensionHost-fd66c8d63f16 >> rep-ok-json 28 "{\"closedRepositories\":[]}"
```
As you can see, it's possible and even common for the backend to send requests to the frontend, but they can go in either direction. The decoder output here shows the type, the request id, and the payload is different for different types. Here we're showing an array, but this is actually just a convenient way to collect the various values decoded for this type. Luckily the source for this protocol is all quite centralized in this [one main source file](https://github.com/microsoft/vscode/blob/1813b35895c3aeb2047f162207c31ba9ec351a04/src/vs/workbench/services/extensions/common/rpcProtocol.ts), but you can just as well look at the decoder.ts file to see what these values are.  

You can at least see which value is probably the method name. Again, often prefixed with $. You can take this value and search the codebase to see more type information about that method. Luckily, a lot of the methods of this protocol are also centrally located in [this one file](https://github.com/microsoft/vscode/blob/8558da133548b1a0b83f038e103ffa7f84f47da4/src/vs/workbench/api/common/extHost.protocol.ts). However, I suspect third party extensions can add to this.

## How the decoder proxy works

Since I started writing the proxy in Go, I was expecting to have to port these encodings to Go. They're ultimately not *that* complicated, but to save time I found I could use [Goja](https://github.com/dop251/goja) to embed a mostly ES6 compatible JS interpreter in Go, then embed [esbuild](https://esbuild.github.io/) to parse a TypeScript file that could import and use modules from the VSCode source!

I just had to make a fake ISocket that I could push bytes into from Go, then use or copy code from VSCode to handle messages using its own Protocol abstraction. The VSCode source was usable as-is, except for the decoding utilities of the extension host RPC protocol, which were not exported. Luckily, everything I needed was in one file, so I just copied it out and added export keywords, letting it import directly from the VSCode source as it did before. 

Goja and esbuild are an amazing pair and only recently has Goja gotten support for most ES6 features and esbuild can now target ES6 with modern code. The end result is that I could use a codebase as complex as the VSCode TypeScript source *from* Go, *without* Node.js. Amazing.

## License

MIT