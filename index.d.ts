declare module '@karimsa/bench' {
    export interface BenchmarkConfig {
        growthFn?: (index: number) => number
        benchTime?: number
        minIterations?: number
        maxIterations?: number
        forceExit?: boolean
        perfHooks?: boolean
    }

    export interface BenchmarkHelper {
        N(): number
        runConcurrently(runner: (iteration: number) => Promise<void>): Promise<void>
        timeSync<T>(name: string, handler: () => T): T
        timeAsync<T>(name: string, handler: () => Promise<T>): Promise<T>
        resetTimer(): void
        stopTimer(): void
    }

    type CreateBenchmarkUtil = (
        title: string,
        handler: (b: BenchmarkHelper) => Promise<void>,
        config?: BenchmarkConfig
    ) => void

    export const benchmark: CreateBenchmarkUtil & {
        only: CreateBenchmarkUtil
    }
}

