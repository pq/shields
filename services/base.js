'use strict'

// See available emoji at http://emoji.muan.co/
const emojic = require('emojic')
const Joi = require('joi')
const queryString = require('query-string')
const pathToRegexp = require('path-to-regexp')
const {
  NotFound,
  InvalidResponse,
  Inaccessible,
  InvalidParameter,
  Deprecated,
} = require('./errors')
const coalesce = require('../lib/coalesce')
const { checkErrorResponse } = require('../lib/error-helper')
const {
  makeLogo,
  toArray,
  makeColor,
  setBadgeColor,
} = require('../lib/badge-data')
const { staticBadgeUrl } = require('../lib/make-badge-url')
const trace = require('./trace')
const validateExample = require('./validate-example')

class BaseService {
  constructor({ sendAndCacheRequest }, { handleInternalErrors }) {
    this._requestFetcher = sendAndCacheRequest
    this._handleInternalErrors = handleInternalErrors
  }

  static render(props) {
    throw new Error(`render() function not implemented for ${this.name}`)
  }

  /**
   * Asynchronous function to handle requests for this service. Take the route
   * parameters (as defined in the `route` property), perform a request using
   * `this._sendAndCacheRequest`, and return the badge data.
   */
  async handle(namedParams, queryParams) {
    throw new Error(`Handler not implemented for ${this.constructor.name}`)
  }

  // Metadata

  /**
   * Name of the category to sort this badge into (eg. "build"). Used to sort
   * the badges on the main shields.io website.
   */
  static get category() {
    return 'unknown'
  }

  /**
   * Returns an object:
   *  - base: (Optional) The base path of the routes for this service. This is
   *    used as a prefix.
   *  - format: Regular expression to use for routes for this service's badges
   *  - capture: Array of names for the capture groups in the regular
   *             expression. The handler will be passed an object containing
   *             the matches.
   *  - queryParams: Array of names for query parameters which will the service
   *                 uses. For cache safety, only the whitelisted query
   *                 parameters will be passed to the handler.
   */
  static get route() {
    throw new Error(`Route not defined for ${this.name}`)
  }

  /**
   * Default data for the badge. Can include things such as default logo, color,
   * etc. These defaults will be used if the value is not explicitly overridden
   * by either the handler or by the user via query parameters.
   */
  static get defaultBadgeData() {
    return {}
  }

  /**
   * Example URLs for this service. These should use the format
   * specified in `route`, and can be used to demonstrate how to use badges for
   * this service.
   *
   * The preferred way to specify an example is with `namedParams` which are
   * substitued into the service's compiled route pattern. The rendered badge
   * is specified with `staticExample`.
   *
   * For services which use a route `format`, the `pattern` can be specified as
   * part of the example.
   *
   * title: Descriptive text that will be shown next to the badge. The default
   *   is to use the service class name, which probably is not what you want.
   * namedParams: An object containing the values of named parameters to
   *   substitute into the compiled route pattern.
   * query: An object containing query parameters to include in the example URLs.
   * pattern: The route pattern to compile. Defaults to `this.route.pattern`.
   * urlPattern: Deprecated. An alias for `pattern`.
   * staticExample: A rendered badge of the sort returned by `handle()` or
   *   `render()`: an object containing `message` and optional `label` and
   *   `color`. This is usually generated by invoking `this.render()` with some
   *   explicit props.
   * previewUrl: Deprecated. An explicit example which is rendered as part of
   *   the badge listing.
   * exampleUrl: Deprecated. An explicit example which will be displayed to
   *   the user, but not rendered.
   * keywords: Additional keywords, other than words in the title. This helps
   *   users locate relevant badges.
   * documentation: An HTML string that is included in the badge popup.
   */
  static get examples() {
    return []
  }

  static _makeFullUrl(partialUrl) {
    return `/${[this.route.base, partialUrl].filter(Boolean).join('/')}`
  }

  static _makeFullUrlFromParams(pattern, namedParams, ext = 'svg') {
    const fullPattern = `${this._makeFullUrl(
      pattern
    )}.:ext(svg|png|gif|jpg|json)`

    const toPath = pathToRegexp.compile(fullPattern, {
      strict: true,
      sensitive: true,
    })

    return toPath({ ext, ...namedParams })
  }

  static _makeStaticExampleUrl(serviceData) {
    const badgeData = this._makeBadgeData({}, serviceData)
    return staticBadgeUrl({
      label: badgeData.text[0],
      message: `${badgeData.text[1]}`,
      color: badgeData.colorscheme || badgeData.colorB,
    })
  }

  static _dotSvg(url) {
    if (url.includes('?')) {
      return url.replace('?', '.svg?')
    } else {
      return `${url}.svg`
    }
  }

  /**
   * Return an array of examples. Each example is prepared according to the
   * schema in `lib/all-badge-examples.js`.
   */
  static prepareExamples() {
    return this.examples.map((example, index) => {
      const {
        title,
        query,
        namedParams,
        exampleUrl,
        previewUrl,
        pattern,
        staticExample,
        documentation,
        keywords,
      } = validateExample(example, index, this)

      const stringified = queryString.stringify(query)
      const suffix = stringified ? `?${stringified}` : ''

      let outExampleUrl
      let outPreviewUrl
      let outPattern
      if (namedParams) {
        outExampleUrl = this._makeFullUrlFromParams(pattern, namedParams)
        outPreviewUrl = this._makeStaticExampleUrl(staticExample)
        outPattern = `${this._dotSvg(this._makeFullUrl(pattern))}${suffix}`
      } else if (staticExample) {
        outExampleUrl = `${this._dotSvg(
          this._makeFullUrl(exampleUrl)
        )}${suffix}`
        outPreviewUrl = this._makeStaticExampleUrl(staticExample)
        outPattern = `${this._dotSvg(this._makeFullUrl(pattern))}${suffix}`
      } else {
        outExampleUrl = undefined
        outPreviewUrl = `${this._dotSvg(
          this._makeFullUrl(previewUrl)
        )}${suffix}`
        outPattern = undefined
      }

      return {
        title: title ? `${title}` : this.name,
        exampleUrl: outExampleUrl,
        previewUrl: outPreviewUrl,
        urlPattern: outPattern,
        documentation,
        keywords,
      }
    })
  }

  static get _regexFromPath() {
    const { pattern } = this.route
    const fullPattern = `${this._makeFullUrl(
      pattern
    )}.:ext(svg|png|gif|jpg|json)`

    const keys = []
    const regex = pathToRegexp(fullPattern, keys, {
      strict: true,
      sensitive: true,
    })
    const capture = keys.map(item => item.name).slice(0, -1)

    return { regex, capture }
  }

  static get _regex() {
    const { pattern, format, capture } = this.route
    if (
      pattern !== undefined &&
      (format !== undefined || capture !== undefined)
    ) {
      throw Error(
        `Since the route for ${
          this.name
        } includes a pattern, it should not include a format or capture`
      )
    } else if (pattern !== undefined) {
      return this._regexFromPath.regex
    } else if (format !== undefined) {
      return new RegExp(
        `^${this._makeFullUrl(this.route.format)}\\.(svg|png|gif|jpg|json)$`
      )
    } else {
      throw Error(`The route for ${this.name} has neither pattern nor format`)
    }
  }

  static get _cacheLength() {
    const cacheLengths = {
      build: 30,
      license: 3600,
      version: 300,
      debug: 60,
    }
    return cacheLengths[this.category]
  }

  static _namedParamsForMatch(match) {
    const { pattern, capture } = this.route
    const names = pattern ? this._regexFromPath.capture : capture || []

    // Assume the last match is the format, and drop match[0], which is the
    // entire match.
    const captures = match.slice(1, -1)

    if (names.length !== captures.length) {
      throw new Error(
        `Service ${this.name} declares incorrect number of capture groups ` +
          `(expected ${names.length}, got ${captures.length})`
      )
    }

    const result = {}
    names.forEach((name, index) => {
      result[name] = captures[index]
    })
    return result
  }

  _handleError(error) {
    if (error instanceof NotFound || error instanceof InvalidParameter) {
      trace.logTrace('outbound', emojic.noGoodWoman, 'Handled error', error)
      return {
        message: error.prettyMessage,
        color: 'red',
      }
    } else if (
      error instanceof InvalidResponse ||
      error instanceof Inaccessible ||
      error instanceof Deprecated
    ) {
      trace.logTrace('outbound', emojic.noGoodWoman, 'Handled error', error)
      return {
        message: error.prettyMessage,
        color: 'lightgray',
      }
    } else if (this._handleInternalErrors) {
      if (
        !trace.logTrace(
          'unhandledError',
          emojic.boom,
          'Unhandled internal error',
          error
        )
      ) {
        // This is where we end up if an unhandled exception is thrown in
        // production. Send the error to the logs.
        console.log(error)
      }
      return {
        label: 'shields',
        message: 'internal error',
        color: 'lightgray',
      }
    } else {
      trace.logTrace(
        'unhandledError',
        emojic.boom,
        'Unhandled internal error',
        error
      )
      throw error
    }
  }

  static async invoke(
    context = {},
    config = {},
    namedParams = {},
    queryParams = {}
  ) {
    trace.logTrace('inbound', emojic.womanCook, 'Service class', this.name)
    trace.logTrace('inbound', emojic.ticket, 'Named params', namedParams)
    trace.logTrace('inbound', emojic.crayon, 'Query params', queryParams)

    const serviceInstance = new this(context, config)

    let serviceData
    try {
      serviceData = await serviceInstance.handle(namedParams, queryParams)
    } catch (error) {
      serviceData = serviceInstance._handleError(error)
    }

    trace.logTrace('outbound', emojic.shield, 'Service data', serviceData)

    return serviceData
  }

  static _makeBadgeData(overrides, serviceData) {
    const {
      style,
      label: overrideLabel,
      logo: overrideLogo,
      logoColor: overrideLogoColor,
      logoWidth: overrideLogoWidth,
      link: overrideLink,
      colorA: overrideColorA,
      colorB: overrideColorB,
    } = overrides

    const {
      label: serviceLabel,
      message: serviceMessage,
      color: serviceColor,
      link: serviceLink,
    } = serviceData

    const {
      color: defaultColor,
      logo: defaultLogo,
      label: defaultLabel,
    } = this.defaultBadgeData

    const badgeData = {
      text: [
        // Use `coalesce()` to support empty labels and messages, as in the
        // static badge.
        coalesce(overrideLabel, serviceLabel, defaultLabel, this.category),
        coalesce(serviceMessage, 'n/a'),
      ],
      template: style,
      logo: makeLogo(style === 'social' ? defaultLogo : undefined, {
        logo: overrideLogo,
        logoColor: overrideLogoColor,
      }),
      logoWidth: +overrideLogoWidth,
      links: toArray(overrideLink || serviceLink),
      colorA: makeColor(overrideColorA),
    }
    const color = overrideColorB || serviceColor || defaultColor || 'lightgrey'
    setBadgeColor(badgeData, color)

    return badgeData
  }

  static register({ camp, handleRequest, githubApiProvider }, serviceConfig) {
    const { cacheHeaders: cacheConfig } = serviceConfig
    camp.route(
      this._regex,
      handleRequest(cacheConfig, {
        queryParams: this.route.queryParams,
        handler: async (queryParams, match, sendBadge, request) => {
          const namedParams = this._namedParamsForMatch(match)
          const serviceData = await this.invoke(
            {
              sendAndCacheRequest: request.asPromise,
              sendAndCacheRequestWithCallbacks: request,
              githubApiProvider,
            },
            serviceConfig,
            namedParams,
            queryParams
          )

          const badgeData = this._makeBadgeData(queryParams, serviceData)
          // The final capture group is the extension.
          const format = match.slice(-1)[0]
          sendBadge(format, badgeData)
        },
        cacheLength: this._cacheLength,
      })
    )
  }

  static _validate(data, schema) {
    if (!schema || !schema.isJoi) {
      throw Error('A Joi schema is required')
    }
    const { error, value } = Joi.validate(data, schema, {
      allowUnknown: true,
      stripUnknown: true,
    })
    if (error) {
      trace.logTrace(
        'validate',
        emojic.womanShrugging,
        'Response did not match schema',
        error.message
      )
      throw new InvalidResponse({
        prettyMessage: 'invalid response data',
        underlyingError: error,
      })
    } else {
      trace.logTrace(
        'validate',
        emojic.bathtub,
        'Data after validation',
        value,
        { deep: true }
      )
      return value
    }
  }

  async _request({ url, options = {}, errorMessages = {} }) {
    const logTrace = (...args) => trace.logTrace('fetch', ...args)
    logTrace(emojic.bowAndArrow, 'Request', url, '\n', options)
    const { res, buffer } = await this._requestFetcher(url, options)
    logTrace(emojic.dart, 'Response status code', res.statusCode)
    return checkErrorResponse.asPromise(errorMessages)({ buffer, res })
  }
}

module.exports = BaseService
