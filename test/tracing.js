const { it, describe, beforeEach, afterEach } = require('mocha')
const Router = require('..')
const utils = require('./support/utils')

const assert = utils.assert
const createServer = utils.createServer
const request = utils.request

let dc
let tracingChannel

try {
  dc = require('node:diagnostics_channel')
  if (dc.tracingChannel) {
    tracingChannel = dc.tracingChannel
  }
} catch {}

const describeTracing = tracingChannel ? describe : describe.skip

describeTracing('TracingChannel', function () {
  let handlers
  let events

  beforeEach(function () {
    events = []
    handlers = {
      start (ctx) { events.push({ phase: 'start', ctx }) },
      end (ctx) { events.push({ phase: 'end', ctx }) },
      asyncStart (ctx) { events.push({ phase: 'asyncStart', ctx }) },
      asyncEnd (ctx) { events.push({ phase: 'asyncEnd', ctx }) },
      error (ctx) { events.push({ phase: 'error', ctx }) }
    }
  })

  afterEach(function () {
    dc.tracingChannel('express:request').unsubscribe(handlers)
  })

  describe('when no subscribers', function () {
    it('should not affect normal behavior', function (done) {
      const router = new Router()
      const server = createServer(router)

      router.get('/foo', function (req, res) {
        res.statusCode = 200
        res.end('hello')
      })

      request(server)
        .get('/foo')
        .expect(200, 'hello', done)
    })
  })

  describe('context shape', function () {
    it('should provide req, res, and layer in context', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.use(function myMiddleware (req, res, next) {
        next()
      })

      router.get('/foo', function (req, res) {
        res.statusCode = 200
        res.end('hello')
      })

      request(server)
        .get('/foo')
        .expect(200, function (err) {
          if (err) return done(err)

          const startEvents = events.filter(function (e) { return e.phase === 'start' })
          const middlewareStart = startEvents.find(function (e) {
            return e.ctx.layer && e.ctx.layer.name === 'myMiddleware'
          })

          assert.ok(middlewareStart, 'should have start event for myMiddleware')
          assert.ok(middlewareStart.ctx.req, 'should have req')
          assert.ok(middlewareStart.ctx.res, 'should have res')
          assert.ok(middlewareStart.ctx.layer, 'should have layer')
          assert.equal(middlewareStart.ctx.layer.name, 'myMiddleware')

          done()
        })
    })

    it('should have layer.name as <anonymous> for unnamed middleware', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.use(function (req, res, next) {
        next()
      })

      router.get('/foo', function (req, res) {
        res.statusCode = 200
        res.end('hello')
      })

      request(server)
        .get('/foo')
        .expect(200, function (err) {
          if (err) return done(err)

          const startEvents = events.filter(function (e) { return e.phase === 'start' })
          const anonMiddleware = startEvents.find(function (e) {
            return e.ctx.layer && e.ctx.layer.name === '<anonymous>'
          })

          assert.ok(anonMiddleware, 'should have anonymous middleware event')

          done()
        })
    })
  })

  describe('route handler tracing', function () {
    it('should have req.route set for route handlers', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/users/:id', function getUser (req, res) {
        res.statusCode = 200
        res.end('user')
      })

      request(server)
        .get('/users/123')
        .expect(200, function (err) {
          if (err) return done(err)

          const startEvents = events.filter(function (e) { return e.phase === 'start' })
          const handlerStart = startEvents.find(function (e) {
            return e.ctx.layer && e.ctx.layer.name === 'getUser'
          })

          assert.ok(handlerStart, 'should have start event for getUser')
          assert.ok(handlerStart.ctx.req.route, 'should have req.route')
          assert.equal(handlerStart.ctx.req.route.path, '/users/:id')

          done()
        })
    })

    it('should not trace the route dispatch wrapper', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/foo', function myHandler (req, res) {
        res.statusCode = 200
        res.end('ok')
      })

      request(server)
        .get('/foo')
        .expect(200, function (err) {
          if (err) return done(err)

          const startEvents = events.filter(function (e) { return e.phase === 'start' })
          const dispatchWrapper = startEvents.find(function (e) {
            return e.ctx.layer && e.ctx.layer.name === 'handle'
          })

          assert.ok(!dispatchWrapper, 'should not have dispatch wrapper event')

          done()
        })
    })
  })

  describe('error handler tracing', function () {
    it('should trace error handlers (fn.length === 4) and mark their ctx as handled', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/fail', function failingHandler (req, res, next) {
        next(new Error('boom'))
      })

      router.use(function myErrorHandler (err, req, res, next) { // eslint-disable-line no-unused-vars
        res.statusCode = 500
        res.end(err.message)
      })

      request(server)
        .get('/fail')
        .expect(500, 'boom', function (err) {
          if (err) return done(err)

          const byLayer = function (name) {
            return function (e) { return e.ctx.layer && e.ctx.layer.name === name }
          }

          const failingEvents = events.filter(byLayer('failingHandler'))
          const errorHandlerEvents = events.filter(byLayer('myErrorHandler'))

          const errorHandlerStart = errorHandlerEvents.find(function (e) { return e.phase === 'start' })
          assert.ok(errorHandlerStart, 'should have start event for error handler')
          assert.equal(errorHandlerStart.ctx.layer.handle.length, 4)
          assert.equal(errorHandlerStart.ctx.handled, true,
            'error handler ctx should be marked handled so APMs can dedup the origin error')
          assert.ok(errorHandlerStart.ctx.error,
            'error handler ctx should expose the error it received')

          assert.ok(!errorHandlerEvents.some(function (e) { return e.phase === 'error' }),
            'error handler itself did not throw, so it should not emit error')

          const failingError = failingEvents.find(function (e) { return e.phase === 'error' })
          assert.ok(failingError, 'origin layer should emit error for next(err)')
          assert.equal(failingError.ctx.error.message, 'boom')
          assert.ok(!failingError.ctx.handled,
            'origin layer ctx is not the handler — should not be marked handled')

          done()
        })
    })

    it('should emit error on originating layer when next(err) is recovered downstream', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/fail', function failingHandler (req, res, next) {
        next(new Error('boom'))
      })

      router.use(function myErrorHandler (err, req, res, next) { // eslint-disable-line no-unused-vars
        res.statusCode = 500
        res.end(err.message)
      })

      request(server)
        .get('/fail')
        .expect(500, 'boom', function (err) {
          if (err) return done(err)

          const byLayer = function (name) {
            return function (e) { return e.ctx.layer && e.ctx.layer.name === name }
          }

          const failingEvents = events.filter(byLayer('failingHandler'))
          const errorHandlerEvents = events.filter(byLayer('myErrorHandler'))

          const failingError = failingEvents.find(function (e) { return e.phase === 'error' })
          assert.ok(failingError,
            'originating layer should emit error — unhandled-at-origin is always observable')
          assert.equal(failingError.ctx.error.message, 'boom')

          assert.ok(!errorHandlerEvents.some(function (e) { return e.phase === 'error' }),
            'recovering error handler itself did not throw — should not emit error')

          const errorHandlerStart = errorHandlerEvents.find(function (e) { return e.phase === 'start' })
          assert.equal(errorHandlerStart.ctx.handled, true,
            'error handler ctx is marked handled so APMs can dedup against the origin error')

          const errorEvents = events.filter(function (e) { return e.phase === 'error' })
          assert.equal(errorEvents.length, 1,
            'exactly one error event fires — on the origin layer that called next(err)')

          done()
        })
    })

    it('should nest the error handler span inside the originating layer span', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.use(function firstMiddleware (req, res, next) {
        next()
      })

      router.get('/fail', function failingHandler (req, res, next) {
        next(new Error('boom'))
      })

      router.use(function myErrorHandler (err, req, res, next) { // eslint-disable-line no-unused-vars
        res.statusCode = 500
        res.end(err.message)
      })

      request(server)
        .get('/fail')
        .expect(500, 'boom', function (err) {
          if (err) return done(err)

          const syncEvents = events.filter(function (e) {
            return e.phase === 'start' || e.phase === 'end'
          }).map(function (e) {
            return e.phase + ':' + (e.ctx.layer && e.ctx.layer.name)
          })

          const failingStart = syncEvents.indexOf('start:failingHandler')
          const failingEnd = syncEvents.indexOf('end:failingHandler')
          const errorHandlerStart = syncEvents.indexOf('start:myErrorHandler')
          const errorHandlerEnd = syncEvents.indexOf('end:myErrorHandler')

          assert.notEqual(failingStart, -1, 'failingHandler should have start')
          assert.notEqual(errorHandlerStart, -1, 'myErrorHandler should have start')

          assert.ok(failingStart < errorHandlerStart,
            'failing layer start should come before error handler start')
          assert.ok(errorHandlerStart < errorHandlerEnd,
            'error handler start should come before its own end')
          assert.ok(errorHandlerEnd < failingEnd,
            'error handler end should come before failing layer end — nesting contract: the error handler that runs via next(err) is nested inside the layer that triggered it, letting APMs attribute the error to the correct parent span')

          done()
        })
    })

    it('should emit error on originating layer when next(err) is unhandled', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/fail', function failingHandler (req, res, next) {
        next(new Error('unhandled boom'))
      })

      request(server)
        .get('/fail')
        .expect(500, function (err) {
          if (err) return done(err)

          const failingEvents = events.filter(function (e) {
            return e.ctx.layer && e.ctx.layer.name === 'failingHandler'
          })

          const failingError = failingEvents.find(function (e) { return e.phase === 'error' })
          assert.ok(failingError,
            'unhandled next(err) must be observable on the origin layer')
          assert.equal(failingError.ctx.error.message, 'unhandled boom')

          const errorEvents = events.filter(function (e) { return e.phase === 'error' })
          assert.equal(errorEvents.length, 1,
            'exactly one error event fires — on the origin layer that called next(err)')

          done()
        })
    })
  })

  describe('error channel', function () {
    it('should emit error when handler throws synchronously', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/throw', function (req, res) {
        throw new Error('sync boom')
      })

      request(server)
        .get('/throw')
        .expect(500, function (err) {
          if (err) return done(err)

          const errorEvents = events.filter(function (e) { return e.phase === 'error' })
          assert.ok(errorEvents.length > 0, 'should have error events')

          const errorEvent = errorEvents.find(function (e) {
            return e.ctx.error && e.ctx.error.message === 'sync boom'
          })
          assert.ok(errorEvent, 'should have error event with the thrown error')

          done()
        })
    })

    it('should emit error when async handler rejects', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/reject', async function (req, res) {
        throw new Error('async boom')
      })

      request(server)
        .get('/reject')
        .expect(500, function (err) {
          if (err) return done(err)

          const errorEvents = events.filter(function (e) { return e.phase === 'error' })
          assert.ok(errorEvents.length > 0, 'should have error events')

          const errorEvent = errorEvents.find(function (e) {
            return e.ctx.error && e.ctx.error.message === 'async boom'
          })
          assert.ok(errorEvent, 'should have error event with the rejected error')

          done()
        })
    })

    it('should emit error on route only when sync throw is recovered by a clean error handler', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/throw', function throwingHandler (req, res) {
        throw new Error('sync boom')
      })

      router.use(function cleanErrorHandler (err, req, res, next) { // eslint-disable-line no-unused-vars
        res.statusCode = 500
        res.end(err.message)
      })

      request(server)
        .get('/throw')
        .expect(500, 'sync boom', function (err) {
          if (err) return done(err)

          const errorEvents = events.filter(function (e) { return e.phase === 'error' })
          assert.equal(errorEvents.length, 1, 'exactly one error event should fire')
          assert.equal(errorEvents[0].ctx.layer.name, 'throwingHandler',
            'error event should belong to the throwing route layer')

          done()
        })
    })

    it('should emit error on route only when async reject is recovered by a clean error handler', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/reject', async function rejectingHandler (req, res) {
        throw new Error('async boom')
      })

      router.use(function cleanErrorHandler (err, req, res, next) { // eslint-disable-line no-unused-vars
        res.statusCode = 500
        res.end(err.message)
      })

      request(server)
        .get('/reject')
        .expect(500, 'async boom', function (err) {
          if (err) return done(err)

          const errorEvents = events.filter(function (e) { return e.phase === 'error' })
          assert.equal(errorEvents.length, 1, 'exactly one error event should fire')
          assert.equal(errorEvents[0].ctx.layer.name, 'rejectingHandler',
            'error event should belong to the rejecting route layer')

          done()
        })
    })

    it('should emit error on both layers when sync throw is followed by a throwing error handler', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/throw', function throwingHandler (req, res) {
        throw new Error('sync boom')
      })

      router.use(function throwingErrorHandler (err, req, res, next) { // eslint-disable-line no-unused-vars
        throw new Error('handler boom')
      })

      request(server)
        .get('/throw')
        .expect(500, function (err) {
          if (err) return done(err)

          const errorEvents = events.filter(function (e) { return e.phase === 'error' })
          const layerNames = errorEvents.map(function (e) { return e.ctx.layer.name })

          assert.equal(errorEvents.length, 2, 'error should fire on both layers')
          assert.ok(layerNames.includes('throwingHandler'), 'route layer should emit error')
          assert.ok(layerNames.includes('throwingErrorHandler'), 'error handler should emit its own error')

          done()
        })
    })

    it('should emit error on both layers when async reject is followed by a throwing error handler', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/reject', async function rejectingHandler (req, res) {
        throw new Error('async boom')
      })

      router.use(function throwingErrorHandler (err, req, res, next) { // eslint-disable-line no-unused-vars
        throw new Error('handler boom')
      })

      request(server)
        .get('/reject')
        .expect(500, function (err) {
          if (err) return done(err)

          const errorEvents = events.filter(function (e) { return e.phase === 'error' })
          const layerNames = errorEvents.map(function (e) { return e.ctx.layer.name })

          assert.equal(errorEvents.length, 2, 'error should fire on both layers')
          assert.ok(layerNames.includes('rejectingHandler'), 'route layer should emit error')
          assert.ok(layerNames.includes('throwingErrorHandler'), 'error handler should emit its own error')

          done()
        })
    })
  })

  describe('async handlers', function () {
    it('should trace async handlers that return promises', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/async', function asyncHandler (req, res) {
        return new Promise(function (resolve) {
          setTimeout(function () {
            res.statusCode = 200
            res.end('async hello')
            resolve()
          }, 10)
        })
      })

      request(server)
        .get('/async')
        .expect(200, 'async hello', function (err) {
          if (err) return done(err)

          const startEvents = events.filter(function (e) { return e.phase === 'start' })
          const asyncEndEvents = events.filter(function (e) { return e.phase === 'asyncEnd' })

          assert.ok(startEvents.length > 0, 'should have start events')
          assert.ok(asyncEndEvents.length > 0, 'should have asyncEnd events')

          done()
        })
    })
  })

  describe('nested routers', function () {
    it('should trace middleware in nested routers', function (done) {
      const router = new Router()
      const nested = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      nested.get('/bar', function nestedHandler (req, res) {
        res.statusCode = 200
        res.end('nested')
      })

      router.use('/foo', nested)

      request(server)
        .get('/foo/bar')
        .expect(200, 'nested', function (err) {
          if (err) return done(err)

          const startEvents = events.filter(function (e) { return e.phase === 'start' })
          const handlerEvent = startEvents.find(function (e) {
            return e.ctx.layer && e.ctx.layer.name === 'nestedHandler'
          })
          assert.ok(handlerEvent, 'should have event from nested route handler')
          assert.ok(handlerEvent.ctx.req.route, 'should have req.route')

          done()
        })
    })
  })

  describe('event ordering', function () {
    it('should emit start before asyncEnd', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.get('/order', function (req, res) {
        res.statusCode = 200
        res.end('ok')
      })

      request(server)
        .get('/order')
        .expect(200, function (err) {
          if (err) return done(err)

          const phases = events.map(function (e) { return e.phase })
          const firstStart = phases.indexOf('start')
          const lastAsyncEnd = phases.lastIndexOf('asyncEnd')

          assert.ok(firstStart >= 0, 'should have start')
          assert.ok(lastAsyncEnd >= 0, 'should have asyncEnd')
          assert.ok(firstStart < lastAsyncEnd, 'start should come before asyncEnd')

          done()
        })
    })
  })

  describe('multiple middleware', function () {
    it('should emit events for each middleware in the chain', function (done) {
      const router = new Router()
      const server = createServer(router)

      dc.tracingChannel('express:request').subscribe(handlers)

      router.use(function first (req, res, next) {
        next()
      })

      router.use(function second (req, res, next) {
        next()
      })

      router.get('/multi', function handler (req, res) {
        res.statusCode = 200
        res.end('multi')
      })

      request(server)
        .get('/multi')
        .expect(200, function (err) {
          if (err) return done(err)

          const startEvents = events.filter(function (e) { return e.phase === 'start' })
          const names = startEvents.map(function (e) { return e.ctx.layer.name })

          assert.ok(names.indexOf('first') >= 0, 'should trace first middleware')
          assert.ok(names.indexOf('second') >= 0, 'should trace second middleware')

          done()
        })
    })
  })
})
