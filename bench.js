// For documentation on benchmarks, please see: `src/commands/bench.js`

import { performance, PerformanceObserver } from 'perf_hooks'

import chalk from 'chalk'
import createDebug from 'debug'
import * as ansi from 'ansi-escapes'
import { v4 as uuid } from 'uuid'

function ttywrite(stream, str) {
	if (str === undefined) {
		str = stream
		stream = process.stdout
	}

	if (process.stdout.isTTY && !debug.enabled && !isCI) {
		stream.write('\r' + ansi.eraseEndLine + str)
	}
}

const isCI = !!process.env.CI

const TableUtils = require('cli-table/lib/utils')
TableUtils.truncate = (str) => str
const Table = require('cli-table')

const debug = createDebug('wiz')
const kHasRunSerially = Symbol('kHasRunSerially')

let benchmarksScheduled = false
let onlyAcceptOnlys = false
let registeredBenchmarks = new Map()
let longestBenchmarkTitleLength = 0
let benchmarkRunningHasBegun = false

const cliTable = new Table({
	chars: {
		top: '',
		'top-mid': '',
		'top-left': '',
		'top-right': '',
		bottom: '',
		'bottom-mid': '',
		'bottom-left': '',
		'bottom-right': '',
		left: '',
		'left-mid': '',
		mid: '',
		'mid-mid': '',
		right: '',
		'right-mid': '',
		middle: ' ',
	},
	colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
})

const benchConfig = JSON.parse(process.env.WIZ_BENCH || '{}')

function appendTable(row) {
	if (!process.stdout.isTTY || isCI) {
		if (row.length === 1) {
			return console.log(row[0])
		}
		return console.log(
			`${row[0]}${' '.repeat(
				Math.max(1, longestBenchmarkTitleLength + 13 - row[0].length)
			)}${row[1]}\t${row.slice(2).join('\t')}`
		)
	}

	cliTable.push(row)

	ttywrite('')
	if (cliTable.length > 1) {
		ttywrite(ansi.cursorUp(cliTable.length - 1))
	}

	ttywrite(cliTable.toString() + '\n')
	cliTable.options.colWidths = []
}

function fibonacci(n) {
	if (n <= 2) {
		return 1
	}

	let a = 1
	let b = 1
	let c = a + b
	for (let i = 3; i < n; i++) {
		a = b
		b = c
		c = a + b
	}
	return c
}

function magnitude(n) {
	return 10 ** n
}

function ms(time) {
	if (time >= 1000 * 1000 * 60) {
		return {
			time: Math.round((time / (1000 * 1000 * 60)) * 10) / 10,
			unit: 'm',
			raw: time,
		}
	} else if (time >= 1000 * 1000) {
		return {
			time: Math.round((time / (1000 * 1000)) * 10) / 10,
			unit: 's',
			raw: time,
		}
	} else if (time >= 1000) {
		return {
			time: Math.round((time / 1000) * 10) / 10,
			unit: 'ms',
			raw: time,
		}
	}
	return {
		time: Math.round(time * 10) / 10,
		unit: 'µs',
		raw: time,
	}
}

function prettyNumber(num) {
	num = String(num)
	let string = ''
	let numDigits = 0

	for (let i = num.length - 1; i > -1; --i) {
		string = num[i] + string
		if (++numDigits % 3 === 0) {
			string = ' ' + string
		}
	}

	return string.trimLeft()
}

function isDefined(value) {
	return value !== undefined && value !== null
}

function loadBenchConfig() {
	const config = {
		growthFn: magnitude,
		benchTime: 1000 * 1000,
		minIterations: 1,
		maxIterations: Infinity,
		forceExit: false,
		perfHooks: true,
	}

	if (config.growthFn === 'fibonacci') {
		config.growthFn = fibonacci
	}
	if (isDefined(benchConfig.benchTime)) {
		config.benchTime = benchConfig.benchTime
	}
	if (isDefined(benchConfig.minIterations)) {
		config.minIterations = benchConfig.minIterations
	}
	if (isDefined(benchConfig.maxIterations)) {
		config.maxIterations = benchConfig.maxIterations
	}
	if (isDefined(benchConfig.forceExit)) {
		config.forceExit = benchConfig.forceExit
	}
	if (isDefined(benchConfig.perfHooks)) {
		config.perfHooks = benchConfig.perfHooks
	}

	debug(`Benchmark config loaded => %O`, config)
	return config
}

export async function runAllBenchmarks() {
	const globalConfig = loadBenchConfig()
	let allBenchmarksSucceeded = true
	benchmarkRunningHasBegun = true

	// sort so that like-named benchmarks are next to each other for easier
	// comparison
	const entries = Array.from(registeredBenchmarks.entries()).sort((a, b) => {
		return a[0] >= b[0] ? 1 : -1
	})

	for (let i = 0; i < entries.length; ++i) {
		const [title, handlers] = entries[i]

		let options = { ...globalConfig }
		const benchmarkHasOverrides =
			typeof handlers[handlers.length - 1] === 'object'

		if (benchmarkHasOverrides) {
			Object.assign(options, handlers[handlers.length - 1])
			if (typeof options.growthFn === 'string') {
				options.growthFn =
					options.growthFn === 'fibonacci' ? fibonacci : magnitude
			}
		}

		try {
			let startTime
			let endTime
			let avgDurationPerOp = 0
			let avgOpsPerSecond = 0
			let numIterations = options.minIterations
			let runNumber = 1
			let numIterationsWasChecked
			let timerIsRunning = true
			let ranSerially = false

			const b = {
				N() {
					numIterationsWasChecked = true
					return numIterations
				},
				async runConcurrently(fn) {
					if (handlers[kHasRunSerially]) {
						const goals = new Array(b.N())
						for (let i = 0; i < goals.length; ++i) {
							goals[i] = fn(i)
						}
						await Promise.all(goals)
					} else {
						ranSerially = true
						handlers[kHasRunSerially] = true

						// reset the index of the entry so benchmark
						// will repeat
						i--

						for (let i = 0; i < b.N(); ++i) {
							await fn(i)
						}
					}
				},
				timeSync(name, fn) {
					const startId = uuid()
					performance.mark(startId)

					try {
						return fn()
					} finally {
						const endId = uuid()
						performance.mark(endId)
						performance.measure(name, startId, endId)
					}
				},
				async timeAsync(name, fn) {
					const startId = uuid()
					performance.mark(startId)

					try {
						return await fn()
					} finally {
						const endId = uuid()
						performance.mark(endId)
						performance.measure(name, startId, endId)
					}
				},
				resetTimer() {
					startTime = performance.now() * 1e3
					timerIsRunning = true
					debug(`Timer reset to: ${startTime}`)
				},
				stopTimer() {
					if (!timerIsRunning) {
						throw new Error(`Timer stopped twice`)
					}
					endTime = performance.now() * 1e3
					timerIsRunning = false
					debug(`Timer stopped at: ${endTime} (+${endTime - startTime}µs)`)
				},
			}

			const fn = benchmarkHasOverrides
				? handlers[handlers.length - 2]
				: handlers[handlers.length - 1]
			let args = [b]

			ttywrite(`preparing: ${title}`)
			let lastElement = handlers.length - 1
			if (benchmarkHasOverrides) {
				lastElement--
			}
			for (let i = 0; i < lastElement; i++) {
				args = await handlers[i](args)
			}

			let numPerfEvents = 0
			let numPerfEventTypes = 0

			const perfEvents = new Map()
			const perfObserver = new PerformanceObserver((events) => {
				events.getEntries().forEach((event) => {
					if (!perfEvents.has(event.name)) {
						numPerfEventTypes++
						perfEvents.set(event.name, [])
					}

					numPerfEvents++
					perfEvents.get(event.name).push(event.duration)
				})
			})
			perfObserver.observe({
				entryTypes: ['measure'],
			})

			while (true) {
				numIterationsWasChecked = false
				ttywrite(`running: ${title} (N = ${prettyNumber(numIterations)})`)
				b.resetTimer()
				await fn.apply(global, args)
				if (timerIsRunning) {
					b.stopTimer()
				}

				if (!numIterationsWasChecked) {
					throw new Error(
						`Benchmark '${title}' ran without calling b.N() - please see documentation`
					)
				}

				const duration = endTime - startTime
				process.stderr.write('\r')
				debug(`${title} completed with N = ${numIterations} in ${duration}`)

				avgDurationPerOp = duration / numIterations
				if (duration > 0) {
					avgOpsPerSecond = (1000 * 1000) / (duration / numIterations)
				}

				if (
					duration >= options.benchTime ||
					numIterations >= options.maxIterations
				) {
					debug(
						`${title} benchmark concluded (duration: ${duration}; iterations: ${numIterations}; config: %O)`,
						{
							benchTime: options.benchTime,
							maxIterations: options.maxIterations,
							growthFn: options.growthFn,
						}
					)
					break
				}

				numIterations = options.growthFn(++runNumber)
			}

			perfObserver.disconnect()

			const { time, unit } = ms(avgDurationPerOp)
			appendTable([
				'\t' +
					title +
					(ranSerially
						? ' (serial)'
						: handlers[kHasRunSerially]
						? ' (concurrent)'
						: ''),
				prettyNumber(Math.floor(avgOpsPerSecond)) + ' ops/s',
				`${time} ${unit}/op`,
			])
			if (numPerfEventTypes > 0) {
				if (options.perfHooks) {
					const totalTime = [...perfEvents.values()].reduce((sum, durations) => sum + durations.reduce((sum, time) => sum + time, 0), 0);
					const entries = Array.from(perfEvents.entries())
						.map(([eventType, durations]) => {
							const totalMSDuration = durations.reduce((a, b) => a + b, 0)
							const duration = ms((1e3 * totalMSDuration) / durations.length)
							const opsPerSecond = durations.length / (totalMSDuration / 1e3)
							const totalDuration = ms(totalMSDuration)
							return [eventType, opsPerSecond, duration, totalDuration, Math.floor((totalMSDuration / totalTime) * 100), durations.length]
						})
						.sort((a, b) => {
							return b[3].raw - a[3].raw
						})

					for (const [
						eventType,
						opsPerSecond,
						{ time, unit },
						cumulativeTimeSpentMs,
						cumulativeTimeSpentPercentage,
						numEvents,
					] of entries) {
						appendTable([
							`\t ↪ ${eventType}`,
							`${prettyNumber(Math.floor(opsPerSecond))} events/s`,
							`${time} ${unit}/event`,
							`${Math.floor(numEvents / numIterations)} events/op`,
							`${cumulativeTimeSpentMs.time} ${cumulativeTimeSpentMs.unit}`,
							`${cumulativeTimeSpentPercentage}%`
						])
					}
				} else {
					appendTable([
						chalk.gray(
							`\tObserved ${numPerfEventTypes} events with ${prettyNumber(
								numPerfEvents
							)} occurrences.`
						),
					])
				}
			}
		} catch (error) {
			allBenchmarksSucceeded = false
			console.error(
				`\r${ansi.eraseEndLine}\t${title}\tFailed with: ${String(error.stack)
					.split('\n')
					.map((line, index) => {
						if (index === 0) {
							return line
						}
						return '\t' + line
					})
					.join('\n')}`
			)
		}
	}

	if (!allBenchmarksSucceeded) {
		process.exit(1)
	} else if (globalConfig.forceExit) {
		console.warn(`warn: forcing exit`)
		process.exit()
	}
}

function addBenchmark(title, handlers) {
	if (benchmarkRunningHasBegun) {
		throw new Error(
			`Benchmark "${title}" registered after execution has already begun`
		)
	}
	if (registeredBenchmarks.has(title)) {
		throw new Error(`Duplicate benchmark registered with title: '${title}'`)
	}
	longestBenchmarkTitleLength = Math.max(
		longestBenchmarkTitleLength,
		title.length
	)
	registeredBenchmarks.set(title, handlers)
}

/**
 * This function registers benchmarks to the benchmark runner. For most basic use,
 * pass a string title describing the benchmark and a handler to run the benchmark.
 *
 * Benchmark titles should be unique across your codebase. This is verified by the
 * benchmark registration and the process will fail if you use a non-unique title.
 *
 * **Advanced: Using currying**
 *
 * The benchmark function also supports currying handlers to perform custom setup.
 * You can think of this as synonymous to `beforeEach()` in mocha. The way that
 * this works is that functions will be executed in the order that they are passed
 * in order to create a set of arguments that should be passed to the final handler
 * upon each invocation of the benchmark. The `b` object is never re-instantiated, but
 * the values returned by `b.N()` will change and should not be cached by setup
 * handlers.
 *
 * ###### Example
 *
 * ```javascript
 * import { benchmark } from '@karimsa/wiz/bench'
 *
 * import { createApi } from '../__tests__/helpers'
 *
 * async function setup(b) {
 * 		const api = await createApi({ version: 'v1' })
 * 		await api.setupUsers(10)
 *
 * 		return {
 * 			b,
 * 			api,
 * 		}
 * }
 *
 * benchmark('my custom benchmark', setup, async ({ b, api }) => {
 * 		// b.resetTimer() is unnecessary here since the execution
 * 		// time of 'setup()' is completely ignored by the runner
 *
 * 		for (let i = 0; i < b.N(); ++i) {
 * 			await api.addRecord({ i })
 * 		}
 * })
 * ```
 *
 * @type function
 */
export const benchmark = Object.assign(
	function (title, ...handlers) {
		if (!onlyAcceptOnlys) {
			addBenchmark(title, handlers)
		}
		if (!benchmarksScheduled) {
			benchmarksScheduled = true
			process.nextTick(runAllBenchmarks)
		}
	},
	{
		only(title, ...handlers) {
			if (!onlyAcceptOnlys) {
				onlyAcceptOnlys = true
				registeredBenchmarks = new Map()
				longestBenchmarkTitleLength = 0
			}
			addBenchmark(title, handlers)
			if (!benchmarksScheduled) {
				benchmarksScheduled = true
				process.nextTick(runAllBenchmarks)
			}
		},
	}
)
