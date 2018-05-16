import { Observable, Subject, Subscription, interval, of } from 'rxjs';
import { WebSocketSubject, WebSocketSubjectConfig } from 'rxjs/webSocket';
import { root } from 'rxjs/internal/util/root';
import { distinctUntilChanged, catchError, takeWhile, map, filter } from 'rxjs/operators';

import * as ws from 'websocket';

import { Buffer } from 'buffer';

/**
 * Extends default config to add reconnection data and serializer
 */
export interface RxSocketClientConfig {
    /** The url of the socket server to connect to */
    url: string;
    /** The protocol to use to connect */
    protocol?: string | Array<string>;
    /**
     * A WebSocket constructor to use. This is useful for mocking a WebSocket
     * for testing purposes
     */
    WebSocketCtor?: { new(url: string, protocol?: string | Array<string>): WebSocket };
    /** Sets the `binaryType` property of the underlying WebSocket. */
    binaryType?: 'blob' | 'arraybuffer';
    /** Sets the reconnection interval value. */
    reconnectInterval?: number;
    /** Sets the reconnection attempts value. */
    reconnectAttempts?: number;
}

/** Type of message sent to server */
export type WebSocketMessage = string | Buffer | ArrayBuffer | Blob | ArrayBufferView;

/** Type of message received from server */
export type WebSocketMessageServer = {
    event: string;
    data: string;
}

/** Type of binary received from server */
export type WebSocketBinaryServer = Buffer | ArrayBuffer | Blob | ArrayBufferView;

/**
 * Class definition
 */
export class RxSocketClientSubject<T> extends Subject<T> {
    // Observable for reconnection stream
    private _reconnectionObservable: Observable<number>;
    // WebSocketSubjectConfig instance
    private _wsSubjectConfig: WebSocketSubjectConfig<T>;
    // WebSocketSubject instance
    private _socket: WebSocketSubject<any>;
    // Subject for connection status stream
    private _connectionStatus$: Subject<boolean>;
    // Socket Subscription
    private _socketSubscription: Subscription;
    // Reconnection Subscription
    private _reconnectionSubscription: Subscription;
    // Reconnect interval
    private _reconnectInterval: number;
    // Reconnect attempts
    private _reconnectAttempts: number;

    /**
     * Class constructor
     *
     * @param urlConfigOrSource
     */
    constructor(urlConfigOrSource: string | RxSocketClientConfig) {
        super();

        // define connection status subject
        this._connectionStatus$ = new Subject<boolean>();

        // set reconnect interval
        if ((<RxSocketClientConfig> urlConfigOrSource).reconnectInterval) {
            this._reconnectInterval = (<RxSocketClientConfig> urlConfigOrSource).reconnectInterval;
        } else {
            this._reconnectInterval = 5000;
        }

        // set reconnect attempts
        if ((<RxSocketClientConfig> urlConfigOrSource).reconnectAttempts) {
            this._reconnectAttempts = (<RxSocketClientConfig> urlConfigOrSource).reconnectAttempts;
        } else {
            this._reconnectAttempts = 10;
        }

        // check type of constructor's parameter to add url in config
        if (typeof urlConfigOrSource === 'string') {
            // create minimum config object
            this._wsSubjectConfig = Object.assign({}, { url: urlConfigOrSource });
        } else {
            // create minimum config object
            this._wsSubjectConfig = Object.assign({}, { url: urlConfigOrSource.url });
        }

        // add protocol in config
        if ((<RxSocketClientConfig> urlConfigOrSource).protocol) {
            Object.assign(this._wsSubjectConfig, { protocol: (<RxSocketClientConfig> urlConfigOrSource).protocol });
        }

        // node environment
        if (!root.WebSocket) {
            root[ 'WebSocket' ] = ws[ 'w3cwebsocket' ];
        }

        // add WebSocketCtor in config
        if ((<RxSocketClientConfig> urlConfigOrSource).WebSocketCtor) {
            Object.assign(this._wsSubjectConfig, { WebSocketCtor: (<RxSocketClientConfig> urlConfigOrSource).WebSocketCtor });
        }

        // add binaryType in config
        if ((<RxSocketClientConfig> urlConfigOrSource).binaryType) {
            Object.assign(this._wsSubjectConfig, { binaryType: (<RxSocketClientConfig> urlConfigOrSource).binaryType });
        }

        // add default data in config
        Object.assign(this._wsSubjectConfig, {
            deserializer: this._deserializer,
            serializer: this._serializer,
            openObserver: {
                next: (e: Event) => {
                    this._connectionStatus$.next(true);
                }
            },
            closeObserver: {
                next: (e: CloseEvent) => {
                    this._cleanSocket();
                    this._connectionStatus$.next(false);
                }
            }
        });

        // connect socket
        this._connect();

        // connection status subscription
        this.connectionStatus$.subscribe(isConnected => {
            if (!this._reconnectionObservable && typeof(isConnected) === 'boolean' && !isConnected) {
                this._reconnect();
            }
        });
    }

    /**
     * Returns connection status observable
     *
     * @return {Observable<boolean>}
     */
    get connectionStatus$(): Observable<boolean> {
        return this._connectionStatus$
            .pipe(
                distinctUntilChanged()
            );
    }

    /**
     * Function to send data by socket
     *
     * @param data
     */
    send(data: any): void {
        this._socket.next(data);
    }

    /**
     * Function to handle text response for given event from server
     *
     * @example <caption>UTF Text Message from server</caption>
     *
     * const message = {
     *  type: 'utf8',
     *  utf8Data: {
     *      event: 'data',
     *      data: 'Data from the server'
     *  }
     * }
     *
     * @example <caption>Simple Text Message from server</caption>
     *
     * const message = {
     *  event: 'data',
     *  data: 'Data from the server'
     * }
     *
     * @param event represents value inside {utf8Data.event} or {event} from server response
     *
     *  @value error | complete | <any>
     *  @example <caption>Event type</caption>
     *
     *  if (event === 'error') => handle Observable's error
     *  else if (event === 'complete') => handle Observable's complete
     *  else handle Observable's success
     *
     * @param cb is the function executed if event matches the response from the server
     */
    on(event: string | 'error' | 'close', cb: (data?: any) => void): void {
        this._message$<WebSocketMessageServer>(event)
            .subscribe(
                (message: WebSocketMessageServer): void => cb(message.data),
                (error: Error): void => {
                    /* istanbul ignore else */
                    if (event === 'error') {
                        cb(error);
                    }
                },
                (): void => {
                    /* istanbul ignore else */
                    if (event === 'close') {
                        cb();
                    }
                }
            );
    }

    /**
     * Function to handle bytes response from server
     *
     * @example <caption>Bytes Message from server</caption>
     *
     * const message = {
     *  type: 'binary',
     *  binaryData: <Buffer 74 6f 74 6f>
     * }
     *
     * @example <caption>Simple Bytes Message from server</caption>
     *
     * const message = <Buffer 74 6f 74 6f>
     *
     * @param cb is the function executed if event matches the response from the server
     */
    onBytes(cb: (data: WebSocketBinaryServer) => void): void {
        this.onBytes$()
            .subscribe(
                (message: WebSocketBinaryServer): void => cb(message)
            );
    }

    /**
     * Same as `on` method but with Observable response
     *
     * @param event represents value inside {utf8Data.event} or {event} from server response
     *
     * @return {Observable<any>}
     */
    on$(event: string): Observable<any> {
        return this._message$<WebSocketMessageServer>(event)
            .pipe(
                map(_ => _.data)
            );
    }

    /**
     * Function to handle socket error event from server with Observable
     *
     * @return {Observable<Error>}
     */
    onError$(): Observable<Error> {
        return this
            .pipe(
                catchError(_ => of(_))
            );
    }

    /**
     * Function to handle socket close event from server with Observable
     *
     * @return {Observable<void>}
     */
    onClose$(): Observable<void> {
        return Observable.create(observer => {
            this.subscribe(undefined, undefined, () => {
                observer.next();
                observer.complete();
            });
        });
    }

    /**
     * Returns formatted binary from server with Observable
     *
     * @return {Observable<WebSocketBinaryServer>}
     *
     * @private
     */
    onBytes$(): Observable<WebSocketBinaryServer> {
        return this
            .pipe(
                map((message: any): any =>
                    (message.type && message.type === 'binary' && message.binaryData) ?
                        message.binaryData :
                        message
                )
            );
    }

    /**
     * Function to emit data for given event to server
     *
     * @param event type of data for the server request
     * @param data request data
     */
    emit(event: string, data: any): void {
        this.send({ event, data });
    }

    /**
     * Returns formatted and filtered message from server for given event with Observable
     *
     * @param {string | "error" | "close"} event represents value inside {utf8Data.event} or {event} from server response
     *
     * @return {Observable<WebSocketMessageServer>}
     *
     * @private
     */
    private _message$<WebSocketMessageServer>(event: string | 'error' | 'close'): Observable<WebSocketMessageServer> {
        return this
            .pipe(
                map((message: any): any =>
                    (message.type && message.type === 'utf8' && message.utf8Data) ?
                        message.utf8Data :
                        message
                ),
                filter((message: any): boolean =>
                    message.event &&
                    message.event !== 'error' &&
                    message.event !== 'close' &&
                    message.event === event &&
                    message.data
                )
            );
    }

    /**
     * Function to clean socket data
     *
     * @private
     */
    private _cleanSocket(): void {
        /* istanbul ignore else */
        if (this._socketSubscription) {
            this._socketSubscription.unsubscribe();
        }
        this._socket = undefined;
    }

    /**
     * Function to clean reconnection data
     *
     * @private
     */
    private _cleanReconnection(): void {
        /* istanbul ignore else */
        if (this._reconnectionSubscription) {
            this._reconnectionSubscription.unsubscribe();
        }
        this._reconnectionObservable = undefined;
    }

    /**
     * Function to create socket and subscribe to it
     *
     * @private
     */
    private _connect() {
        this._socket = new WebSocketSubject(this._wsSubjectConfig);
        this._socketSubscription = this._socket.subscribe(
            (m: any) => {
                this.next(m);
            },
            (error: Error) => {
                /* istanbul ignore if */
                if (!this._socket) {
                    this._cleanReconnection();
                    this._reconnect();
                } else {
                    this.error(error);
                }
            }
        );
    }

    /**
     * Function to reconnect socket
     *
     * @private
     */
    private _reconnect(): void {
        this._reconnectionObservable = interval(this._reconnectInterval)
            .pipe(
                takeWhile((v, index) => index < this._reconnectAttempts && !this._socket)
            );

        this._reconnectionSubscription = this._reconnectionObservable.subscribe(
            () => this._connect(),
            undefined,
            () => {
                this._cleanReconnection();
                if (!this._socket) {
                    this.complete();
                    this._connectionStatus$.complete();
                }
            }
        );
    }

    /**
     * Default deserializer
     *
     * @param e
     *
     * @return {any}
     * @private
     */
    private _deserializer(e: MessageEvent): T {
        try {
            return JSON.parse(e.data);
        } catch (err) {
            return e.data;
        }
    };

    /**
     * Default serializer
     *
     * @param data
     *
     * @return {WebSocketMessage}
     * @private
     */
    private _serializer(data: any): WebSocketMessage {
        return typeof(data) === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
    };
}