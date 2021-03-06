import { createSocket, Socket } from 'dgram';
import { RtspRequest } from 'rtsp-server';
import { v4 as uuid } from 'uuid';
import Parser from '@penggy/easy-rtp-parser';

import { Mount, RtspStream } from './Mount';
import { getDebugger, getMountInfo } from './utils';

const debug = getDebugger('Client');

const clientPortRegex = /(?:client_port=)(\d*)-(\d*)/;

export class Client {
  open: boolean;
  id: string;
  mount: Mount;
  stream: RtspStream;

  remoteAddress: string;
  remoteRtcpPort: number;
  remoteRtpPort: number;

  rtpServer: Socket;
  rtpList: Buffer[] = [];
  rtcpServer: Socket;
  rtcpList: Buffer[] = [];
  rtpServerPort?: number;
  rtcpServerPort?: number;

  constructor(mount: Mount, req: RtspRequest) {
    this.open = true;

    this.id = uuid();
    const info = getMountInfo(req.uri);
    this.mount = mount;

    if (this.mount.path !== info.path) {
      throw new Error('Mount does not equal request provided');
    }

    this.stream = this.mount.streams[info.streamId];

    if (!req.socket.remoteAddress || !req.headers.transport) {
      throw new Error(
        "No remote address found or transport header doesn't exist",
      );
    }

    const portMatch: RegExpMatchArray | null = req.headers.transport.match(
      clientPortRegex,
    );

    this.remoteAddress = req.socket.remoteAddress.replace('::ffff:', ''); // Strip IPv6 thing out

    if (!portMatch) {
      throw new Error('Unable to find client ports in transport header');
    }

    this.remoteRtpPort = parseInt(portMatch[1], 10);
    this.remoteRtcpPort = parseInt(portMatch[2], 10);

    this.setupServerPorts();

    this.rtpServer = createSocket('udp4');
    this.rtcpServer = createSocket('udp4');
  }

  /**
   *
   * @param req
   */
  async setup(req: RtspRequest): Promise<void> {
    let portError = false;

    try {
      await this.listen();
    } catch (e) {
      // One or two of the ports was in use, cycle them out and try another
      if (e.errno && e.errno === 'EADDRINUSE') {
        console.warn(
          `Port error on ${e.port}, for stream ${this.stream.id} using another port`,
        );
        portError = true;

        try {
          await this.rtpServer.close();
          await this.rtcpServer.close();
        } catch (e) {
          // Ignore, dont care if couldnt close
          console.warn(e);
        }

        if (this.rtpServerPort) {
          this.mount.mounts.returnRtpPortToPool(this.rtpServerPort);
        }

        this.setupServerPorts();
      } else {
        throw e;
      }
    }

    if (portError) {
      return this.setup(req);
    }

    debug(
      '%s:%s Client set up for path %s, local ports (%s:%s) remote ports (%s:%s)',
      req.socket.remoteAddress,
      req.socket.remotePort,
      this.stream.mount.path,
      this.rtpServerPort,
      this.rtcpServerPort,
      this.remoteRtpPort,
      this.remoteRtcpPort,
    );
  }

  /**
   *
   */
  play(): void {
    this.stream.clients[this.id] = this;
  }

  /**
   *
   */
  async close(): Promise<void> {
    this.open = false;
    this.mount.clientLeave(this);

    return new Promise((resolve) => {
      // Sometimes closing can throw if the dgram has already gone away. Just ignore it.
      try {
        this.rtpServer.close();
      } catch (e) {
        debug('Error closing rtpServer for client %o', e);
      }
      try {
        this.rtcpServer.close();
      } catch (e) {
        debug('Error closing rtcpServer for client %o', e);
      }

      if (this.rtpServerPort) {
        this.mount.mounts.returnRtpPortToPool(this.rtpServerPort);
      }

      return resolve();
    });
  }

  //
  // timestamp modification for live stream
  //
  /**
   *
   * @param buf
   */
  sendRtp(buf: Buffer) {
    this.rtpList.push(buf);
    if (this.rtpList.length > 5) {
      this.rtpList.shift();
    }
    if (this.open === true) {
      let pkt;
      while ((pkt = this.rtpList.shift()) !== undefined) {
        this.rtpServer.send(pkt, this.remoteRtpPort, this.remoteAddress);
      }
    }
  }

  /**
   *
   * @param buf
   */
  sendRtcp(buf: Buffer) {
    this.rtcpList.push(buf);
    if (this.rtcpList.length > 5) {
      this.rtcpList.shift();
    }
    if (this.open === true) {
      let pkt;
      while ((pkt = this.rtcpList.shift()) !== undefined) {
        this.rtcpServer.send(pkt, this.remoteRtcpPort, this.remoteAddress);
      }
    }
  }

  /**
   *
   */
  private async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      function onError(err: Error) {
        return reject(err);
      }

      this.rtpServer.on('error', onError);

      this.rtpServer.bind(this.rtpServerPort, () => {
        this.rtpServer.removeListener('error', onError);

        this.rtcpServer.on('error', onError);
        this.rtcpServer.bind(this.rtcpServerPort, () => {
          this.rtcpServer.removeListener('error', onError);

          return resolve();
        });
      });
    });
  }

  private setupServerPorts(): void {
    const rtpServerPort = this.mount.mounts.getNextRtpPort();
    if (!rtpServerPort) {
      throw new Error('Unable to get next RTP Server Port');
    }

    this.rtpServerPort = rtpServerPort;
    this.rtcpServerPort = this.rtpServerPort + 1;
  }
}
