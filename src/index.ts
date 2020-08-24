const kOnHeaders = 0;
const kOnHeadersComplete = 1;
const kOnBody = 2;
const kOnMessageComplete = 3;
const kOnExecute = 4;

export const methods = [
    'DELETE',
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'CONNECT',
    'OPTIONS',
    'TRACE',
    'COPY',
    'LOCK',
    'MKCOL',
    'MOVE',
    'PROPFIND',
    'PROPPATCH',
    'SEARCH',
    'UNLOCK',
    'BIND',
    'REBIND',
    'UNBIND',
    'ACL',
    'REPORT',
    'MKACTIVITY',
    'CHECKOUT',
    'MERGE',
    'M-SEARCH',
    'NOTIFY',
    'SUBSCRIBE',
    'UNSUBSCRIBE',
    'PATCH',
    'PURGE',
    'MKCALENDAR',
    'LINK',
    'UNLINK'
];

export class HTTPParser {
    /**
     * Binds the custom parser, must be run before the 'http' module is imported
     */
    static bind() {
        const httpParserBinding = ((process as any).binding as (binding: string) => any)('http_parser');
        httpParserBinding.HTTPParser = this;
        httpParserBinding.methods = this.methods;

        // If binding was requested ensure that it succeeded
        this.verify();
    }

    /**
     * Checks if the parser was successfully bound, otherwise throws an exception
     */
    static verify() {
        const internalMethods = require('http').METHODS;
        for (let i = 0; i < internalMethods.length; i++) {
            if (this.methods[i] !== internalMethods[i])
                throw new Error("HTTP module imported before HTTPParser was bound");
        }
    }

    static readonly REQUEST = 'REQUEST';
    static readonly RESPONSE = 'RESPONSE';

    static encoding: BufferEncoding = 'ascii';
    static maxHeaderSize = 80 * 1024; // maxHeaderSize (in bytes) is configurable, but 80kb by default;

    static readonly kOnHeaders = kOnHeaders;
    static readonly kOnHeadersComplete = kOnHeadersComplete;
    static readonly kOnBody = kOnBody;
    static readonly kOnMessageComplete = kOnMessageComplete;
    static readonly kOnExecute = kOnExecute;

    static readonly methods = methods;

    protected static readonly HEADER_STATES = ['REQUEST_LINE', 'RESPONSE_LINE', 'HEADER'];
    protected static readonly FINISH_STATES = ['REQUEST_LINE', 'RESPONSE_LINE', 'BODY_RAW'];

    protected type!: typeof HTTPParser.REQUEST | typeof HTTPParser.RESPONSE;
    protected state?: 'REQUEST_LINE'
            | 'RESPONSE_LINE'
            | 'HEADER'
            | 'BODY_CHUNK'
            | 'BODY_CHUNKHEAD'
            | 'BODY_CHUNKEND'
            | 'BODY_CHUNKTRAILERS'
            | 'BODY_SIZED'
            | 'BODY_RAW';

    protected info!: {
        method?: number;
        url?: string;
        statusCode?: number;
        statusMessage?: string;
        versionMajor?: number;
        versionMinor?: number;
        headers: string[];
        trailers: string[];
        upgrade: boolean;
        connection?: string;
        shouldKeepAlive?: boolean;
    };

    protected chunk: Buffer | null = null;
    protected offset: number = 0;
    protected length: number = 0;

    protected line: string = '';

    protected isChunked!: boolean;
    protected headerSize!: number;
    protected bodyBytes!: number | null;

    protected hadError: boolean = false;

    constructor() {}

    initialize(type: typeof HTTPParser.REQUEST | typeof HTTPParser.RESPONSE) {
        this.type = type;

        if (type === HTTPParser.REQUEST) this.state = 'REQUEST_LINE';
        else if (type === HTTPParser.RESPONSE) this.state = 'RESPONSE_LINE';
        else throw new Error(`Invalid parser type: ${type}`);

        this.info = {
            headers: [],
            trailers: [],
            upgrade: false
        };

        this.isChunked = false;
        this.headerSize = 0;
        this.bodyBytes = null;

        this.hadError = false;
    }

    // Some handler stubs, needed for compatibility
    [kOnHeaders]!: (headers: string[], url: string) => void;
    [kOnHeadersComplete]!: (versionMajor: number, versionMinor: number, headers: string[], method: number,
            url: string, statusCode: number, statusMessage: string, upgrade: boolean, shouldKeepAlive: boolean) => number;
    [kOnBody]!: (buffer: Buffer, start: number, length: number) => void;
    [kOnMessageComplete]!: () => void;
    [kOnExecute]!: () => void;

    close() {}
    free() {}

    pause() {}
    resume() {}

    // These three methods are used for an internal speed optimization, and it also
    // works if theses are noops. Basically consume() asks us to read the bytes
    // ourselves, but if we don't do it we get them through execute().
    _consumed: boolean = false;
    consume(handle: any){}
    unconsume(){}
    getCurrentBuffer(){}

    execute(chunk: Buffer) {
        this.chunk = chunk;
        this.offset = 0;
        this.length = chunk.length;
        while (this.offset < this.length) {
            try {
                if (this[this.state!]()) break;
            } catch (err) {
                if (!(err instanceof ParseError)) throw err;
                this.hadError = true;
                return err;
            }
        }
        this.chunk = null;
        if (HTTPParser.HEADER_STATES.includes(this.state!)) {
            this.headerSize += this.offset;
            if (this.headerSize > HTTPParser.maxHeaderSize)
                return new ParseError('HPE_HEADER_OVERFLOW', "Too many header bytes seen; overflow detected");
        }
        return this.offset;
    }

    finish() {
        if (this.hadError) return;
        if (!HTTPParser.FINISH_STATES.includes(this.state!))
            return new ParseError('HPE_INVALID_EOF_STATE', "Stream ended at an unexpected time");
        if (this.state === 'BODY_RAW') this[kOnMessageComplete]();
    }

    protected nextRequest() {
        this[kOnMessageComplete]();
        this.initialize(this.type);
    }

    protected consumeLine() {
        for (let i = this.offset; i < this.length; i++) {
            if (this.chunk![i] === 0x0a) { // \n
                let line = this.line + this.chunk!.toString(HTTPParser.encoding, this.offset, i);
                if (line.charCodeAt(line.length - 1) === 0x0d)
                    line = line.substr(0, line.length - 1);

                this.line = '';
                this.offset = i + 1;
                return line;
            }
        }
        // Line split over multiple chunks
        this.line += this.chunk!.toString(HTTPParser.encoding, this.offset, this.length);
        this.offset = this.length;
    }

    protected static readonly HEADER_REGEX = /^([^: \t]+):[ \t]*((?:.*[^ \t])|)/;
    protected static readonly HEADER_CONTINUE_REGEX = /^[ \t]+(.*[^ \t])/;
    protected parseHeader(line: string, headers: string[]) {
        if (line.indexOf('\r') !== -1)
            throw new ParseError('HPE_LF_EXPECTED', "LF character expected");

        const match = HTTPParser.HEADER_REGEX.exec(line);
        if (match !== null && match.length >= 3) { // skip empty string (malformed header)
            headers.push(match[1]);
            headers.push(match[2]);
        } else {
            const matchContinue = HTTPParser.HEADER_CONTINUE_REGEX.exec(line);
            if (matchContinue && headers.length > 0)
                headers[headers.length - 1] += (headers[headers.length - 1].length > 0 ? ' ' : '') + matchContinue[1];
        }
    }

    protected static readonly REQUEST_REGEX = /^([A-Z-]+) ([^ ]+) HTTP\/(\d)\.(\d)$/;
    protected REQUEST_LINE() {
        const line = this.consumeLine();
        if (line === undefined || line.length === 0) return;
        const match = HTTPParser.REQUEST_REGEX.exec(line);
        if (match === null)
            throw new ParseError('HPE_INVALID_CONSTANT', "Invalid constant string");

        this.info.method = HTTPParser.methods.indexOf(match[1]);
        if (this.info.method === -1)
            throw new ParseError('HPE_INVALID_METHOD', "Invalid HTTP method");
        this.info.url = match[2];
        this.info.versionMajor = +match[3];
        this.info.versionMinor = +match[4];
        this.bodyBytes = 0;
        this.state = 'HEADER';
    }

    protected static readonly RESPONSE_REGEX = /^HTTP\/(\d)\.(\d) (\d{3}) ?(.*)$/;
    protected RESPONSE_LINE() {
        const line = this.consumeLine();
        if (line === undefined || line.length === 0) return;
        const match = HTTPParser.RESPONSE_REGEX.exec(line);
        if (match === null)
            throw new ParseError('HPE_INVALID_CONSTANT', "Invalid constant string");

        this.info.versionMajor = +match[1];
        this.info.versionMinor = +match[2];
        const statusCode = this.info.statusCode = +match[3];
        this.info.statusMessage = match[4];
        // Implied zero length.
        if ((statusCode / 100 | 0) === 1 || statusCode === 204 || statusCode === 304) {
            this.bodyBytes = 0;
        }
        this.state = 'HEADER';
    }

    protected shouldKeepAlive() {
        if (this.info.versionMajor! > 0 && this.info.versionMinor! > 0) {
            if (this.info.connection?.indexOf('close') !== -1) {
                return false;
            }
        } else if (this.info.connection?.indexOf('keep-alive') === -1) {
            return false;
        }
        return this.bodyBytes !== null || this.isChunked;
    }

    protected HEADER(): boolean | void {
        const line = this.consumeLine();
        if (line === undefined) return;
        if (line.length > 0) {
            this.parseHeader(line, this.info.headers);
            return;
        }

        const info = this.info;
        const headers = info.headers;
        let hasContentLength = false;
        let hasUpgradeHeader = false;
        for (let i = 0; i < headers.length; i += 2) {
            switch (headers[i].toLowerCase()) {
                case 'transfer-encoding':
                    this.isChunked = headers[i + 1].toLowerCase() === 'chunked';
                    break;
                case 'content-length':
                    const contentLength = +headers[i + 1];

                    // Fix duplicate Content-Length header with same values.
                    // Throw error only if values are different.
                    // Known issues:
                    // https://github.com/request/request/issues/2091#issuecomment-328715113
                    // https://github.com/nodejs/node/issues/6517#issuecomment-216263771
                    if (hasContentLength && contentLength !== this.bodyBytes)
                        throw new ParseError('HPE_UNEXPECTED_CONTENT_LENGTH', "Unexpected content-length header");

                    hasContentLength = true;
                    this.bodyBytes = contentLength;
                    break;
                case 'connection':
                    info.connection += headers[i + 1].toLowerCase();
                    break;
                case 'upgrade':
                    hasUpgradeHeader = true;
                    break;
            }
        }

        // if both isChunked and hasContentLength, isChunked wins
        // This is required so the body is parsed using the chunked method, and matches
        // Chrome's behavior.  We could, maybe, ignore them both (would get chunked
        // encoding into the body), and/or disable shouldKeepAlive to be more
        // resilient.
        if (this.isChunked && hasContentLength) {
            this.bodyBytes = null;
        }

        // Logic from https://github.com/nodejs/http-parser/blob/921d5585515a153fa00e411cf144280c59b41f90/http_parser.c#L1727-L1737
        // "For responses, "Upgrade: foo" and "Connection: upgrade" are
        //   mandatory only when it is a 101 Switching Protocols response,
        //   otherwise it is purely informational, to announce support.
        if (hasUpgradeHeader && this.info.connection!.indexOf('upgrade') != -1) {
            info.upgrade = this.type === HTTPParser.REQUEST || info.statusCode === 101;
        } else {
            info.upgrade = HTTPParser.methods[info.method!] === 'CONNECT';
        }

        if (this.isChunked && info.upgrade) {
            this.isChunked = false;
        }

        info.shouldKeepAlive = this.shouldKeepAlive();
        // Problem which also exists in original node: we should know skipBody before calling onHeadersComplete
        const skipBody = this[kOnHeadersComplete](info.versionMajor!,
                info.versionMinor!, info.headers, info.method!, info.url!, info.statusCode!,
                info.statusMessage!, info.upgrade, info.shouldKeepAlive);

        if (skipBody === 2) {
            this.nextRequest();
            return true;
        } else if (this.isChunked && !skipBody) {
            this.state = 'BODY_CHUNKHEAD';
        } else if (skipBody === 1 || this.bodyBytes === 0) {
            this.nextRequest();
            // For older versions of node (v6.x and older?), that return skipBody=1 or skipBody=true,
            //   need this "return true;" if it's an upgrade request.
            return info.upgrade;
        } else if (this.bodyBytes === null) {
            this.state = 'BODY_RAW';
        } else {
            this.state = 'BODY_SIZED';
        }
    }

    protected BODY_CHUNKHEAD(): void {
        const line = this.consumeLine();
        if (line === undefined) return;

        this.bodyBytes = parseInt(line, 16);
        if (isNaN(this.bodyBytes))
            throw new ParseError('HPE_INVALID_CHUNK_SIZE', "Invalid character in chunk size header");

        if (this.bodyBytes === 0) this.state = 'BODY_CHUNKTRAILERS';
        else this.state = 'BODY_CHUNK';
    }

    protected BODY_CHUNK(): void {
        const length = Math.min(this.length - this.offset, this.bodyBytes!);
        this[kOnBody](this.chunk!, this.offset, length);
        this.offset += length;
        this.bodyBytes! -= length;
        if (this.bodyBytes == 0) this.state = 'BODY_CHUNKEND';
    }

    protected BODY_CHUNKEND(): void {
        const line = this.consumeLine();
        if (line === undefined) return;
        if (line.length !== 0) throw new ParseError('HPE_STRICT', "Chunk exceeded specified length");
        this.state = 'BODY_CHUNKHEAD';
    }

    protected BODY_CHUNKTRAILERS(): void {
        const line = this.consumeLine();
        if (line === undefined) return;
        if (line.length > 0) {
            this.parseHeader(line, this.info.trailers);
            return;
        }

        if (this.info.trailers.length > 0) this[kOnHeaders](this.info.trailers, '');
        this.nextRequest();
    }

    protected BODY_RAW(): void {
        const length = this.length - this.offset;
        this[kOnBody](this.chunk!, this.offset, length);
        this.offset = this.length;
    }

    protected BODY_SIZED(): void {
        const length = Math.min(this.length - this.offset, this.bodyBytes!);
        this[kOnBody](this.chunk!, this.offset, length);
        this.offset += length;
        this.bodyBytes! -= length;
        if (this.bodyBytes === 0) this.nextRequest();
    }
}

export class ParseError extends Error {
    constructor(readonly code: string, reason?: string) {
        super(reason);
    }
}
