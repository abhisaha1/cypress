import * as _ from 'lodash'

export const SERIALIZABLE_REQ_PROPS = [
  'headers',
  'body', // doesn't exist on the OG message, but will be attached by the backend
  'url',
  'method',
  'httpVersion',
]

export const SERIALIZABLE_RES_PROPS = _.concat(
  SERIALIZABLE_REQ_PROPS,
  'statusCode',
  'statusMessage'
)

export const DICT_STRING_MATCHER_FIELDS = ['headers', 'query']

export const STRING_MATCHER_FIELDS = ['auth.username', 'auth.password', 'hostname', 'method', 'path', 'pathname', 'url']

type GlobPattern = string
type StringMatcher = GlobPattern | RegExp
type DictMatcher<T> = { [key: string]: T }
type NumberMatcher = number | number[] // list of acceptable numbers

interface AnnotatedStringMatcher {
  type: 'regex' | 'glob'
  value: string
}

// all HTTP requests have some basic information
// users would use a `RouteMatcher` to "subscribe" to a certain subset of requests

// no callbacks are supported in matchers - helps cut down on un-needed back-and-forth
// websocket requests to match requests - they are all static

// then, the route is handled by a `RouteHandler`, which will either return a static response
// or send a callback to the driver, where it will be handled

// if no `RouteHandler` is set, it just passes through after following the options
/** Types for Route Matching **/

type RouteMatcher = StringMatcher | RouteMatcherOptions

interface RouteMatcherOptionsGeneric<S> extends RouteMatcherCompatOptions {
  auth?: { username: S, password: S }
  headers?: DictMatcher<S>
  hostname?: S
  https?: boolean // serve this over HTTPS
  method?: S // defaults to GET
  path?: S // includes query params
  pathname?: S // does not include query params
  port?: NumberMatcher
  query?: DictMatcher<S> // match querystring values
  url?: S
  webSocket?: boolean
}

export type RouteMatcherOptions = RouteMatcherOptionsGeneric<StringMatcher>

export type AnnotatedRouteMatcherOptions = RouteMatcherOptionsGeneric<AnnotatedStringMatcher>

type CompatXHRHandler = (xhr: XMLHttpRequest /** ? */) => void

interface RouteMatcherCompatOptions {
  onRequest?: CompatXHRHandler
  onResponse?: CompatXHRHandler
  response?: string | object
}

/** Types for Route Responses **/
export declare namespace CyHttpMessages {
  interface BaseMessage {
    // as much stuff from `incomingmessage` as makes sense to serialize and send
    body: any
    headers: { [key: string]: string }
    url: string
    method: string
    httpVersion: string
  }

  interface IncomingResponseError {
    url: string
    error: Error
  }

  export type IncomingResponseSuccess = BaseMessage & {
    statusCode: number
    statusMessage: string
  }

  export type IncomingResponse = IncomingResponseSuccess | IncomingResponseError

  export type IncomingHttpResponse = IncomingResponse & {
    send: (staticResponse?: StaticResponse) => void
    /**
     * Wait for `delayMs` milliseconds before sending the response to the client.
     */
    delay: (delayMs: number) => IncomingHttpResponse
    /**
     * Serve the response at a maximum of `throttleKbps` kilobytes per second.
     */
    throttle: (throttleKbps: number) => IncomingHttpResponse
  }

  export interface IncomingRequest extends BaseMessage {

  }

  export interface IncomingHTTPRequest extends IncomingRequest {
    destroy: () => void
    // if `responseOrInterceptor` is undefined, just forward the modified request to the destination
    reply: (responseOrInterceptor?: StaticResponse | CyResponseInterceptor) => void
    redirect: (location: string, statusCode: 301 | 302 | 303 | 307 | number) => void
  }
}

/**
 * Describes a response that will be sent back to the client.
 */
export interface StaticResponse {
  body?: string
  headers?: { [key: string]: string }
  statusCode?: number
  /**
   * If `destroySocket` is truthy, Cypress will destroy the connection to the browser and send no response.
   *
   * Useful for simulating a server that is not reachable.
   */
  destroySocket?: boolean
}

type CyResponseInterceptor = (res: CyHttpMessages.IncomingHttpResponse, send?: () => void) => void

type HTTPController = (req: CyHttpMessages.IncomingHTTPRequest, next: () => void) => void

interface CyWebSocket {

}

interface CyWebSocketFrame {

}

interface WebSocketController {
  onConnect?: (req: CyHttpMessages.IncomingRequest, socket: CyWebSocket) => void
  onIncomingFrame?: (socket: CyWebSocket, message: CyWebSocketFrame) => void
  onOutgoingFrame?: (socket: CyWebSocket, message: CyWebSocketFrame) => void
  onDisconnect?: (socket: CyWebSocket) => void

  transport: 'socket.io' // socket.io client over websockets
              | 'socket.io-longpolling' // socket.io client via longpolling
              | 'websockets' // vanilla websockets server
}

type RouteHandlerController = HTTPController | WebSocketController

type RouteHandler = string | object | RouteHandlerController

/** Types for messages between driver and server */

export declare namespace NetEventFrames {
  export interface AddRoute {
    routeMatcher: AnnotatedRouteMatcherOptions
    staticResponse?: StaticResponse
    handlerId?: string
  }

  interface BaseHttp {
    requestId: string
    routeHandlerId: string
  }

  // fired when HTTP proxy receives headers + body of request
  export interface HttpRequestReceived extends BaseHttp {
    req: CyHttpMessages.IncomingRequest
  }

  // fired when driver is done modifying request and wishes to pass control back to the proxy
  export interface HttpRequestContinue extends BaseHttp {
    req?: CyHttpMessages.IncomingRequest
    staticResponse?: StaticResponse
    hasResponseHandler?: boolean
    tryNextRoute?: boolean
  }

  // fired when a response is received and the driver has a req.reply callback registered
  export interface HttpResponseReceived extends BaseHttp {
    res: CyHttpMessages.IncomingResponse | CyHttpMessages.IncomingResponseError
  }

  // fired when driver is done modifying response or driver callback completes,
  // passes control back to proxy
  export interface HttpResponseContinue extends BaseHttp {
    res?: CyHttpMessages.IncomingResponse
    staticResponse?: StaticResponse
    delayMs?: number
    throttleKbps?: number
  }
}

/** Driver Commands **/

/**
 * Annotate non-primitive types so that they can be passed to the backend and re-hydrated.
 */
function _annotateMatcherOptionsTypes (options: RouteMatcherOptions) {
  const stringMatcherFields = STRING_MATCHER_FIELDS
  .concat(
    // add the nested DictStringMatcher values to the list of fields to annotate
    _.flatten(
      _.filter(
        DICT_STRING_MATCHER_FIELDS.map((field) => {
          const value = options[field]

          if (value) {
            return _.keys(value).map((key) => {
              return `${field}.${key}`
            })
          }

          return ''
        })
      )
    )
  )

  const ret : AnnotatedRouteMatcherOptions = {}

  stringMatcherFields.forEach((field) => {
    const value = _.get(options, field)

    if (value) {
      _.set(ret, field, {
        type: (_isRegExp(value)) ? 'regex' : 'glob',
        value: value.toString(),
      } as AnnotatedStringMatcher)
    }
  })

  const noAnnotationRequiredFields = ['https', 'port', 'webSocket']

  _.extend(ret, _.pick(options, noAnnotationRequiredFields))

  return ret
}

function _getUniqueId () {
  return `${Number(new Date()).toString()}-${_.uniqueId()}`
}

function _isHttpController (obj) : obj is HTTPController {
  return typeof obj === 'function'
}

function _isWebSocketController (obj, options) : obj is WebSocketController {
  return typeof obj === 'object' && options.webSocket === true
}

function _isRegExp (obj) : obj is RegExp {
  return obj && (obj instanceof RegExp || obj.__proto__ === RegExp.prototype || obj.__proto__.constructor.name === 'RegExp')
}

interface Route {
  options: RouteMatcherOptions
  handler: RouteHandler
  hitCount: number
}

interface Request {
  responseHandler: CyResponseInterceptor
}

let routes : { [key: string]: Route } = {}
let requests : { [key: string]: Request } = {}

function _addRoute (options: RouteMatcherOptions, handler: RouteHandler, emit: Function) : void {
  const handlerId = _getUniqueId()

  const frame: NetEventFrames.AddRoute = {
    handlerId,
    routeMatcher: _annotateMatcherOptionsTypes(options),
  }

  switch (true) {
    case _isHttpController(handler):
      break
    case _isWebSocketController(handler, options):
      break
    case typeof handler === 'string':
      frame.staticResponse = { body: <string>handler }
      break
    case typeof handler === 'object':
      // TODO: automatically JSONify staticResponse.body objects
      frame.staticResponse = <StaticResponse>handler
      break
    default:
      // TODO: warn that only string, object, HttpController, or WebSocketController allowed
  }

  routes[handlerId] = {
    options,
    handler,
    hitCount: 0,
  }

  emit('route:added', frame)
}

export function registerCommands (Commands, Cypress, /** cy, state, config */) {
  // TODO: figure out what to do for XHR compatibility

  function _emit (eventName: string, ...args: any[]) {
    // all messages from driver to server are wrapped in backend:request
    Cypress.backend('net', eventName, ...args)
  }

  function route (matcher: RouteMatcher, handler: RouteHandler) {
    let options : RouteMatcherOptions

    if (matcher instanceof RegExp || typeof matcher === 'string') {
      options = {
        url: matcher,
      }
    } else {
      options = matcher
    }

    _addRoute(options, handler, _emit)
  }

  function server () : void {

  }

  function _onRequestReceived (frame: NetEventFrames.HttpRequestReceived) {
    const route = routes[frame.routeHandlerId]
    const { req, requestId, routeHandlerId } = frame

    const continueFrame : NetEventFrames.HttpRequestContinue = {
      routeHandlerId,
      requestId,
    }

    let continueSent = false

    const sendContinueFrame = () => {
      if (continueSent) {
        throw new Error('Cannot continue a request twice.')
      }

      continueSent = true
      // copy changeable attributes of userReq to req in frame
      // @ts-ignore
      continueFrame.req = {
        ..._.pick(userReq, SERIALIZABLE_REQ_PROPS),
      }

      _emit('http:request:continue', continueFrame)
    }

    if (!route) {
      // TODO: remove this logging once we're done
      // eslint-disable-next-line no-console
      console.log('no handler for HttpRequestReceived', { frame })

      return sendContinueFrame()
    }

    const userReq : CyHttpMessages.IncomingHTTPRequest = {
      ...req,
      reply (responseHandler, maybeBody?, maybeHeaders?) {
        // TODO: this can only be called once
        if (_.isNumber(responseHandler)) {
          // responseHandler is a status code
          const staticResponse : StaticResponse = {
            statusCode: responseHandler,
          }

          if (!_.isUndefined(maybeBody)) {
            staticResponse.body = maybeBody
          }

          if (!_.isUndefined(maybeHeaders)) {
            staticResponse.headers = maybeHeaders
          }

          responseHandler = staticResponse
        }

        if (_.isFunction(responseHandler)) {
          // allow `req` to be sent outgoing, then pass the response body to `responseHandler`
          requests[requestId] = {
            responseHandler,
          }

          // signals server to send a http:response:received
          continueFrame.hasResponseHandler = true

          return
        }

        if (!_.isUndefined(responseHandler)) {
          // `replyHandler` is a StaticResponse
          continueFrame.staticResponse = <StaticResponse>responseHandler
        }
      },
      redirect (location, statusCode = 302) {
        userReq.reply({
          headers: { location },
          statusCode,
        })
      },
      destroy () {
        userReq.reply({
          destroySocket: true,
        })
      },
    }

    const handler = route.handler as Function

    // next() can be called to pass this to the next route
    const next = () => {
      // TODO: this can only be called once
      continueFrame.tryNextRoute = true
      sendContinueFrame()
    }

    if (!_.isFunction(handler)) {
      return next()
    }

    if (handler.length === 1) {
      // did not consume next(), so call it synchronously
      handler(userReq)

      return next()
    }

    // rely on handler to call next()
    handler(userReq, next)
  }

  function _onResponseReceived (frame: NetEventFrames.HttpResponseReceived) {
    const { res, requestId, routeHandlerId } = frame
    const request = requests[requestId]

    const continueFrame : NetEventFrames.HttpResponseContinue = {
      routeHandlerId,
      requestId,
    }

    const sendContinueFrame = () => {
      // copy changeable attributes of userReq to req in frame
      // @ts-ignore
      continueFrame.res = {
        ..._.pick(userRes, SERIALIZABLE_RES_PROPS),
      }

      _emit('http:response:continue', continueFrame)
    }

    const userRes : CyHttpMessages.IncomingHttpResponse = {
      ...res,
      send (staticResponse) {
        if (staticResponse) {
          continueFrame.staticResponse = staticResponse
        }

        return sendContinueFrame()
      },
      delay (delayMs) {
        continueFrame.delayMs = delayMs

        return this
      },
      throttle (throttleKbps) {
        continueFrame.throttleKbps = throttleKbps

        return this
      },
    }

    if (!request) {
      // TODO: remove this logging once we're done
      // eslint-disable-next-line no-console
      console.log('no handler for HttpResponseReceived', { frame })

      return sendContinueFrame()
    }

    request.responseHandler(userRes)
  }

  Cypress.on('test:before:run', () => {
    // wipe out callbacks and routes when tests start
    routes = {}
    Cypress.routes = routes
  })

  Cypress.on('net:event', (eventName, ...args) => {
    switch (eventName) {
      case 'http:request:received':
        _onRequestReceived(<NetEventFrames.HttpRequestReceived>args[0])
        break
      case 'http:response:received':
        _onResponseReceived(<NetEventFrames.HttpResponseReceived>args[0])
        break
      case 'ws:connect':
        break
      case 'ws:disconnect':
        break
      case 'ws:frame:outgoing':
        break
      case 'ws:frame:incoming':
        break
      default:
    }
  })

  Commands.addAll({
    route,
    server,
  })
}
