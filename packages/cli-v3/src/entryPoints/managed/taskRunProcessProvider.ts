import { WorkerManifest } from "@trigger.dev/core/v3";
import { TaskRunProcess } from "../../executions/taskRunProcess.js";
import { RunnerEnv } from "./env.js";
import { RunLogger, SendDebugLogOptions } from "./logger.js";

export interface TaskRunProcessProviderOptions {
  workerManifest: WorkerManifest;
  env: RunnerEnv;
  logger: RunLogger;
  processKeepAliveEnabled: boolean;
  processKeepAliveMaxExecutionCount: number;
}

export interface GetProcessOptions {
  taskRunEnv: Record<string, string>;
  isWarmStart?: boolean;
}

export class TaskRunProcessProvider {
  private readonly workerManifest: WorkerManifest;
  private readonly env: RunnerEnv;
  private readonly logger: RunLogger;
  private readonly processKeepAliveEnabled: boolean;
  private readonly processKeepAliveMaxExecutionCount: number;

  // Process keep-alive state
  private persistentProcess: TaskRunProcess | null = null;
  private executionCount = 0;

  constructor(opts: TaskRunProcessProviderOptions) {
    this.workerManifest = opts.workerManifest;
    this.env = opts.env;
    this.logger = opts.logger;
    this.processKeepAliveEnabled = opts.processKeepAliveEnabled;
    this.processKeepAliveMaxExecutionCount = opts.processKeepAliveMaxExecutionCount;
  }

  /**
   * Gets a TaskRunProcess, either by reusing an existing one or creating a new one
   */
  getProcess(opts: GetProcessOptions): TaskRunProcess {
    this.sendDebugLog("Getting TaskRunProcess", {
      processKeepAliveEnabled: this.processKeepAliveEnabled,
      hasPersistentProcess: !!this.persistentProcess,
      executionCount: this.executionCount,
      maxExecutionCount: this.processKeepAliveMaxExecutionCount,
      isWarmStart: opts.isWarmStart,
    });

    // If process keep-alive is enabled and we have a healthy persistent process, reuse it
    if (this.processKeepAliveEnabled && this.shouldReusePersistentProcess()) {
      this.sendDebugLog("Reusing persistent TaskRunProcess", {
        executionCount: this.executionCount,
      });

      return this.persistentProcess!;
    }

    // Create new process
    this.sendDebugLog("Creating new TaskRunProcess", {
      hadPersistentProcess: !!this.persistentProcess,
      reason: this.processKeepAliveEnabled
        ? "execution limit reached or unhealthy"
        : "keep-alive disabled",
    });

    // Clean up old persistent process if it exists
    if (this.persistentProcess) {
      this.cleanupPersistentProcess();
    }

    const newProcess = this.createTaskRunProcess(opts);
    return newProcess;
  }

  /**
   * Returns a process after execution, handling keep-alive logic
   */
  returnProcess(process: TaskRunProcess): void {
    if (!this.processKeepAliveEnabled) {
      this.sendDebugLog("Keep-alive disabled, not preserving process");
      return;
    }

    if (this.shouldKeepProcessAlive(process)) {
      this.sendDebugLog("Keeping TaskRunProcess alive for next run", {
        executionCount: this.executionCount,
        maxExecutionCount: this.processKeepAliveMaxExecutionCount,
      });

      this.persistentProcess = process;
      this.executionCount++;
    } else {
      this.sendDebugLog("Not keeping TaskRunProcess alive", {
        executionCount: this.executionCount,
        maxExecutionCount: this.processKeepAliveMaxExecutionCount,
        isHealthy: this.isProcessHealthy(process),
      });

      // Don't set as persistent, it will be cleaned up normally
    }
  }

  /**
   * Forces cleanup of any persistent process
   */
  cleanup(): void {
    if (this.persistentProcess) {
      this.cleanupPersistentProcess();
    }
  }

  /**
   * Gets metrics about the provider state
   */
  get metrics() {
    return {
      processKeepAlive: {
        enabled: this.processKeepAliveEnabled,
        executionCount: this.executionCount,
        maxExecutionCount: this.processKeepAliveMaxExecutionCount,
        hasPersistentProcess: !!this.persistentProcess,
      },
    };
  }

  private createTaskRunProcess({ taskRunEnv, isWarmStart }: GetProcessOptions): TaskRunProcess {
    const processEnv = this.buildProcessEnvironment(taskRunEnv);

    const taskRunProcess = new TaskRunProcess({
      workerManifest: this.workerManifest,
      env: processEnv,
      serverWorker: {
        id: "managed",
        contentHash: this.env.TRIGGER_CONTENT_HASH,
        version: this.env.TRIGGER_DEPLOYMENT_VERSION,
        engine: "V2",
      },
      machineResources: {
        cpu: Number(this.env.TRIGGER_MACHINE_CPU),
        memory: Number(this.env.TRIGGER_MACHINE_MEMORY),
      },
      isWarmStart,
    }).initialize();

    return taskRunProcess;
  }

  private buildProcessEnvironment(taskRunEnv: Record<string, string>): Record<string, string> {
    return {
      ...taskRunEnv,
      ...this.env.gatherProcessEnv(),
      HEARTBEAT_INTERVAL_MS: String(this.env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS * 1000),
    };
  }

  private shouldReusePersistentProcess(): boolean {
    return (
      !!this.persistentProcess &&
      this.executionCount < this.processKeepAliveMaxExecutionCount &&
      this.isProcessHealthy(this.persistentProcess)
    );
  }

  private shouldKeepProcessAlive(process: TaskRunProcess): boolean {
    return (
      this.executionCount < this.processKeepAliveMaxExecutionCount && this.isProcessHealthy(process)
    );
  }

  private isProcessHealthy(process: TaskRunProcess): boolean {
    // Basic health check - TaskRunProcess will handle more detailed internal health checks
    return process.isPreparedForNextRun || process.isPreparedForNextAttempt;
  }

  private cleanupPersistentProcess(): void {
    if (this.persistentProcess) {
      this.sendDebugLog("Cleaning up persistent TaskRunProcess");

      // Don't await this - let it cleanup in the background
      this.persistentProcess.kill("SIGKILL").catch(() => {});
      this.persistentProcess = null;
      this.executionCount = 0;
    }
  }

  private sendDebugLog(message: string, properties?: SendDebugLogOptions["properties"]): void {
    this.logger.sendDebugLog({
      runId: undefined, // Provider doesn't have access to current run ID
      message: `[taskRunProcessProvider] ${message}`,
      properties,
    });
  }
}
