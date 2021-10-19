import { Logger, configure, getLogger } from "log4js"

export function initLog(): void {
    // log4ts
    configure({
        appenders: {
            out: { type: "stdout", layout: { type: "dummy" } },
        },
        categories: {
            default: { appenders: ["out"], level: "info" },
        },
    })
}

enum Level {
    TRACE = "TRACE",
    DEBUG = "DEBUG",
    INFO = "INFO",
    WARN = "WARN",
    ERROR = "ERROR",
}

export class Log {
    static getLogger<T>(category: string): Log {
        return new Log(category)
    }

    private readonly log: Logger

    constructor(readonly category: string) {
        this.log = getLogger(category)
    }

    isTraceEnabled(): boolean {
        return this.log.isTraceEnabled()
    }

    isDebugEnabled(): boolean {
        return this.log.isDebugEnabled()
    }

    trace(e: string | Error): void {
        this.log.trace(e)
    }

    debug(e: string | Error): void {
        this.log.debug(e)
    }

    info(e: string | Error): void {
        this.log.info(e)
    }

    jinfo(obj: object): void {
        this.log.info(JSON.stringify(obj))
    }

    async warn(e: string | Error): Promise<void> {
        this.log.warn(e)
    }

    async jwarn(obj: object): Promise<void> {
        const strObj = JSON.stringify(obj)
        this.log.warn(strObj)
    }

    async error(e: string | Error): Promise<void> {
        this.log.error(e)
    }

    async jerror(obj: object): Promise<void> {
        const strObj = JSON.stringify(obj)
        this.log.error(strObj)
    }
}
