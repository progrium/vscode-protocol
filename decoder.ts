import { VSBuffer } from './vscode/src/vs/base/common/buffer';
import { deserialize, BufferReader } from './vscode/src/vs/base/parts/ipc/common/ipc';
import { Protocol } from './vscode/src/vs/base/parts/ipc/common/ipc.net';
import { IDisposable } from './vscode/src/vs/base/common/lifecycle';

import { MessageBuffer, MessageIO, MessageType } from './rpcProtocol';

class FakeSocket {
  // implements ISocket from ipc.net

  listeners: Array<(e: VSBuffer) => void>;

  constructor() {
    this.listeners = [];
  }

  onData(listener: (e: VSBuffer) => void): IDisposable {
    this.listeners.push(listener);
    return {
      dispose() {},
    }
  }

  emitData(data: any) {
    const buf = VSBuffer.wrap(new Uint8Array(data));
    this.listeners.forEach(l => l(buf));
  }

  onClose() {}
  onEnd() {}
  write() {}
  end() {}
  drain() {}
  traceSocketEvent() { }
}

const sock = new FakeSocket();

// this is where data comes in from go
globalThis.push = (data) => sock.emitData(data);

let firstMessage = true;
let stream = "Undetermined";
const p = new Protocol(sock);
p._socketReader.onMessage((msg) => {
  if (msg.type === 1) {
    const reader = new BufferReader(msg.data);
	  const header = deserialize(reader);

    if (firstMessage) {
      firstMessage = false;
      // not sure better way to determine stream,
      // this seems good enough
      if (!header || JSON.stringify(header) === "{}") {
        stream = "ExtensionHost";
      } else {
        stream = "Management";
      }
    }
    
    if (stream === "Management") {
      const body = deserialize(reader);
      const ipcTypeToString = (t) => {
        switch (t) {
          case 100: return 'req';
          case 101: return 'cancel';
          case 102: return 'subscript';
          case 103: return 'unsubscribe';
          case 200: return 'init';
          case 201: return 'reply';
          case 202: 
          case 203: return 'replyErr';
          case 204: return 'event';
        }
      }
      console.log(`${stream}-${tokenSuffix} ${dir} ${ipcTypeToString(header[0])} ${JSON.stringify(header)} ${JSON.stringify(body).slice(0,1024)}`);
      return;
    }

    if (stream === "ExtensionHost") {
      const buff = MessageBuffer.read(msg.data, 0);
      const messageType = <MessageType>buff.readUInt8();
      const req = buff.readUInt32();

      const logMessage = (type, payload) => {
        console.log(`${stream}-${tokenSuffix} ${dir} ${type} ${req} ${JSON.stringify(payload).slice(0, 1024)}`);  
      }

      switch (messageType) {
        case MessageType.RequestJSONArgs:
        case MessageType.RequestJSONArgsWithCancellation: {
          let { rpcId, method, args } = MessageIO.deserializeRequestJSONArgs(buff);
          logMessage("req-json-args", [rpcId, method, args, (messageType === MessageType.RequestJSONArgsWithCancellation)]);
          break;
        }
        case MessageType.RequestMixedArgs:
        case MessageType.RequestMixedArgsWithCancellation: {
          let { rpcId, method, args } = MessageIO.deserializeRequestMixedArgs(buff);
          logMessage("req-mixed-args", [rpcId, method, args, (messageType === MessageType.RequestMixedArgsWithCancellation)]);
          break;
        }
        case MessageType.Acknowledged: {
          logMessage("ack");
          break;
        }
        case MessageType.Cancel: {
          logMessage("cancel");
          break;
        }
        case MessageType.ReplyOKEmpty: {
          logMessage("rep-ok-empty");
          break;
        }
        case MessageType.ReplyOKJSON: {
          let value = MessageIO.deserializeReplyOKJSON(buff);
          logMessage("rep-ok-json", value);
          break;
        }
        case MessageType.ReplyOKJSONWithBuffers: {
          const value = MessageIO.deserializeReplyOKJSONWithBuffers(buff, this._uriTransformer);
          logMessage("rep-ok-json-buffs", value);
          break;
        }
        case MessageType.ReplyOKVSBuffer: {
          const value = MessageIO.deserializeReplyOKVSBuffer(buff);
          logMessage("rep-ok-vsbuff", value);
          break;
        }
        case MessageType.ReplyErrError: {
          let err = MessageIO.deserializeReplyErrError(buff);
          logMessage("rep-err", err);
          break;
        }
        case MessageType.ReplyErrEmpty: {
          logMessage("rep-err");
          break;
        }
        default:
          console.log(`${stream}-${tokenSuffix} ${dir} UNEXPECTED: ${msg.data.toString().slice(0, 1024)}`);
      }
      return;
    }
  } else {
    const msgTypeToString = (t) => {
      switch (t) {
        case 0: return 'None';
        case 1: return 'Regular'; // already handled
        case 2: return 'Control';
        case 3: return 'Ack';
        case 5: return 'Disconnect';
        case 6: return 'ReplayRequest';
        case 7: return 'PauseWriting';
        case 8: return 'ResumeWriting';
        case 9: return 'KeepAlive';
      }
    }
    console.log(`${stream}-${tokenSuffix} ${dir} (${msgTypeToString(msg.type)})`);
  }
});


//
// text encode/decode polyfill from:
// https://github.com/samthor/fast-text-encoding
//
(function(scope) {
  'use strict';
  
  // fail early
  if (scope['TextEncoder'] && scope['TextDecoder']) {
    return false;
  }
  
  // used for FastTextDecoder
  const validUtfLabels = ['utf-8', 'utf8', 'unicode-1-1-utf-8'];
  
  /**
   * @constructor
   */
  function FastTextEncoder() {
    // This does not accept an encoding, and always uses UTF-8:
    //   https://www.w3.org/TR/encoding/#dom-textencoder
  }
  
  Object.defineProperty(FastTextEncoder.prototype, 'encoding', {value: 'utf-8'});
  
  /**
   * @param {string} string
   * @param {{stream: boolean}=} options
   * @return {!Uint8Array}
   */
  FastTextEncoder.prototype['encode'] = function(string, options={stream: false}) {
    if (options.stream) {
      throw new Error(`Failed to encode: the 'stream' option is unsupported.`);
    }
  
    let pos = 0;
    const len = string.length;
  
    let at = 0;  // output position
    let tlen = Math.max(32, len + (len >>> 1) + 7);  // 1.5x size
    let target = new Uint8Array((tlen >>> 3) << 3);  // ... but at 8 byte offset
  
    while (pos < len) {
      let value = string.charCodeAt(pos++);
      if (value >= 0xd800 && value <= 0xdbff) {
        // high surrogate
        if (pos < len) {
          const extra = string.charCodeAt(pos);
          if ((extra & 0xfc00) === 0xdc00) {
            ++pos;
            value = ((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000;
          }
        }
        if (value >= 0xd800 && value <= 0xdbff) {
          continue;  // drop lone surrogate
        }
      }
  
      // expand the buffer if we couldn't write 4 bytes
      if (at + 4 > target.length) {
        tlen += 8;  // minimum extra
        tlen *= (1.0 + (pos / string.length) * 2);  // take 2x the remaining
        tlen = (tlen >>> 3) << 3;  // 8 byte offset
  
        const update = new Uint8Array(tlen);
        update.set(target);
        target = update;
      }
  
      if ((value & 0xffffff80) === 0) {  // 1-byte
        target[at++] = value;  // ASCII
        continue;
      } else if ((value & 0xfffff800) === 0) {  // 2-byte
        target[at++] = ((value >>>  6) & 0x1f) | 0xc0;
      } else if ((value & 0xffff0000) === 0) {  // 3-byte
        target[at++] = ((value >>> 12) & 0x0f) | 0xe0;
        target[at++] = ((value >>>  6) & 0x3f) | 0x80;
      } else if ((value & 0xffe00000) === 0) {  // 4-byte
        target[at++] = ((value >>> 18) & 0x07) | 0xf0;
        target[at++] = ((value >>> 12) & 0x3f) | 0x80;
        target[at++] = ((value >>>  6) & 0x3f) | 0x80;
      } else {
        continue;  // out of range
      }
  
      target[at++] = (value & 0x3f) | 0x80;
    }
  
    // Use subarray if slice isn't supported (IE11). This will use more memory
    // because the original array still exists.
    return target.slice ? target.slice(0, at) : target.subarray(0, at);
  }
  
  /**
   * @constructor
   * @param {string=} utfLabel
   * @param {{fatal: boolean}=} options
   */
  function FastTextDecoder(utfLabel='utf-8', options={fatal: false}) {
    if (validUtfLabels.indexOf(utfLabel.toLowerCase()) === -1) {
      throw new RangeError(
        `Failed to construct 'TextDecoder': The encoding label provided ('${utfLabel}') is invalid.`);
    }
    if (options.fatal) {
      throw new Error(`Failed to construct 'TextDecoder': the 'fatal' option is unsupported.`);
    }
  }
  
  Object.defineProperty(FastTextDecoder.prototype, 'encoding', {value: 'utf-8'});
  
  Object.defineProperty(FastTextDecoder.prototype, 'fatal', {value: false});
  
  Object.defineProperty(FastTextDecoder.prototype, 'ignoreBOM', {value: false});
  
  /**
   * @param {!Uint8Array} bytes
   * @return {string}
   */
  function decodeBuffer(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf-8');
  }
  
  /**
   * @param {!Uint8Array} bytes
   * @return {string}
   */
  function decodeSyncXHR(bytes) {
    let u;
  
    // This hack will fail in non-Edgium Edge because sync XHRs are disabled (and
    // possibly in other places), so ensure there's a fallback call.
    try {
      const b = new Blob([bytes], {type: 'text/plain;charset=UTF-8'});
      u = URL.createObjectURL(b);
  
      const x = new XMLHttpRequest();
      x.open('GET', u, false);
      x.send();
      return x.responseText;
    } catch (e) {
      return decodeFallback(bytes);
    } finally {
      if (u) {
        URL.revokeObjectURL(u);
      }
    }
  }
  
  /**
   * @param {!Uint8Array} bytes
   * @return {string}
   */
  function decodeFallback(bytes) {
    let inputIndex = 0;
  
    // Create a working buffer for UTF-16 code points, but don't generate one
    // which is too large for small input sizes. UTF-8 to UCS-16 conversion is
    // going to be at most 1:1, if all code points are ASCII. The other extreme
    // is 4-byte UTF-8, which results in two UCS-16 points, but this is still 50%
    // fewer entries in the output.
    const pendingSize = Math.min(256 * 256, bytes.length + 1);
    const pending = new Uint16Array(pendingSize);
    const chunks = [];
    let pendingIndex = 0;
  
    for (;;) {
      const more = inputIndex < bytes.length;
  
      // If there's no more data or there'd be no room for two UTF-16 values,
      // create a chunk. This isn't done at the end by simply slicing the data
      // into equal sized chunks as we might hit a surrogate pair.
      if (!more || (pendingIndex >= pendingSize - 1)) {
        // nb. .apply and friends are *really slow*. Low-hanging fruit is to
        // expand this to literally pass pending[0], pending[1], ... etc, but
        // the output code expands pretty fast in this case.
        chunks.push(String.fromCharCode.apply(null, pending.subarray(0, pendingIndex)));
  
        if (!more) {
          return chunks.join('');
        }
  
        // Move the buffer forward and create another chunk.
        bytes = bytes.subarray(inputIndex);
        inputIndex = 0;
        pendingIndex = 0;
      }
  
      // The native TextDecoder will generate "REPLACEMENT CHARACTER" where the
      // input data is invalid. Here, we blindly parse the data even if it's
      // wrong: e.g., if a 3-byte sequence doesn't have two valid continuations.
  
      const byte1 = bytes[inputIndex++];
      if ((byte1 & 0x80) === 0) {  // 1-byte or null
        pending[pendingIndex++] = byte1;
      } else if ((byte1 & 0xe0) === 0xc0) {  // 2-byte
        const byte2 = bytes[inputIndex++] & 0x3f;
        pending[pendingIndex++] = ((byte1 & 0x1f) << 6) | byte2;
      } else if ((byte1 & 0xf0) === 0xe0) {  // 3-byte
        const byte2 = bytes[inputIndex++] & 0x3f;
        const byte3 = bytes[inputIndex++] & 0x3f;
        pending[pendingIndex++] = ((byte1 & 0x1f) << 12) | (byte2 << 6) | byte3;
      } else if ((byte1 & 0xf8) === 0xf0) {  // 4-byte
        const byte2 = bytes[inputIndex++] & 0x3f;
        const byte3 = bytes[inputIndex++] & 0x3f;
        const byte4 = bytes[inputIndex++] & 0x3f;
  
        // this can be > 0xffff, so possibly generate surrogates
        let codepoint = ((byte1 & 0x07) << 0x12) | (byte2 << 0x0c) | (byte3 << 0x06) | byte4;
        if (codepoint > 0xffff) {
          // codepoint &= ~0x10000;
          codepoint -= 0x10000;
          pending[pendingIndex++] = (codepoint >>> 10) & 0x3ff | 0xd800;
          codepoint = 0xdc00 | codepoint & 0x3ff;
        }
        pending[pendingIndex++] = codepoint;
      } else {
        // invalid initial byte
      }
    }
  }
  
  // Decoding a string is pretty slow, but use alternative options where possible.
  let decodeImpl = decodeFallback;
  if (typeof Buffer === 'function' && Buffer.from) {
    // Buffer.from was added in Node v5.10.0 (2015-11-17).
    decodeImpl = decodeBuffer;
  } else if (typeof Blob === 'function' && typeof URL === 'function' && typeof URL.createObjectURL === 'function') {
    // Blob and URL.createObjectURL are available from IE10, Safari 6, Chrome 19
    // (all released in 2012), Firefox 19 (2013), ...
    decodeImpl = decodeSyncXHR;
  }
  
  /**
   * @param {(!ArrayBuffer|!ArrayBufferView)} buffer
   * @param {{stream: boolean}=} options
   * @return {string}
   */
  FastTextDecoder.prototype['decode'] = function(buffer, options={stream: false}) {
    if (options['stream']) {
      throw new Error(`Failed to decode: the 'stream' option is unsupported.`);
    }
  
    let bytes;
  
    if (buffer instanceof Uint8Array) {
      // Accept Uint8Array instances as-is.
      bytes = buffer;
    } else if (buffer.buffer instanceof ArrayBuffer) {
      // Look for ArrayBufferView, which isn't a real type, but basically
      // represents all the valid TypedArray types plus DataView. They all have
      // ".buffer" as an instance of ArrayBuffer.
      bytes = new Uint8Array(buffer.buffer);
    } else {
      // The only other valid argument here is that "buffer" is an ArrayBuffer.
      // We also try to convert anything else passed to a Uint8Array, as this
      // catches anything that's array-like. Native code would throw here.
      bytes = new Uint8Array(buffer);
    }
  
    return decodeImpl(/** @type {!Uint8Array} */ (bytes));
  }
  
  scope['TextEncoder'] = FastTextEncoder;
  scope['TextDecoder'] = FastTextDecoder;
  
  }(globalThis));