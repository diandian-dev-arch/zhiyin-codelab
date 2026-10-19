import {
  BaseCheckpointSaver,
  type CheckpointTuple,
} from "@langchain/langgraph";
import type { DB } from "./db.js";
import type { OwnerIdentity } from "./lifecycle-v2.js";
import { assertAnalysisOwnerV2 } from "./analysis-operations-v2.js";

type Config = Parameters<BaseCheckpointSaver["getTuple"]>[0];
/** Uses the application's transactional DB so checkpoint writes share the ownership fence. */
export class AnalysisCheckpointSaverV2 extends BaseCheckpointSaver {
  private readonly checkpointCommits = new Map<string, Promise<Config>>();
  constructor(
    private db: DB,
    private owner: OwnerIdentity,
    private analysisId: string,
  ) {
    super();
  }
  private identity(config: Config) {
    if (
      config.configurable?.thread_id !== this.analysisId ||
      (config.configurable?.checkpoint_ns ?? "") !== ""
    )
      throw new Error("CHECKPOINT_IDENTITY_MISMATCH");
  }
  private async guard(tx: DB) {
    const owner = await assertAnalysisOwnerV2(tx, this.owner);
    const row = (
      await tx.query(
        "SELECT status,mode,owner_execution_attempt_id,deadlines FROM analysis_attempts WHERE id=$1 FOR UPDATE",
        [this.analysisId],
      )
    ).rows[0];
    if (
      !row ||
      row.status !== "running" ||
      (this.owner.kind === "execution"
        ? row.owner_execution_attempt_id !== this.owner.id
        : this.analysisId !== this.owner.id || row.mode !== "reanalysis") ||
      !Number.isFinite(Date.parse(row.deadlines.analysisDeadlineAt)) ||
      Date.parse(row.deadlines.analysisDeadlineAt) <=
        new Date(owner.db_now).getTime()
    )
      throw new Error("CHECKPOINT_OWNER_LOST");
  }
  private config(id?: string): Config {
    return {
      configurable: {
        thread_id: this.analysisId,
        checkpoint_ns: "",
        ...(id ? { checkpoint_id: id } : {}),
      },
    };
  }
  async getTuple(config: Config): Promise<CheckpointTuple | undefined> {
    this.identity(config);
    const id = config.configurable?.checkpoint_id;
    const row = (
      await this.db.query(
        `SELECT * FROM analysis_checkpoints WHERE analysis_attempt_id=$1 ${id ? "AND checkpoint_id=$2" : ""} ORDER BY checkpoint_id DESC LIMIT 1`,
        id ? [this.analysisId, id] : [this.analysisId],
      )
    ).rows[0];
    if (!row) return undefined;
    const writes = (
      await this.db.query(
        "SELECT * FROM analysis_checkpoint_writes WHERE analysis_attempt_id=$1 AND checkpoint_id=$2 ORDER BY task_id,write_index",
        [this.analysisId, row.checkpoint_id],
      )
    ).rows;
    return {
      config: this.config(row.checkpoint_id),
      checkpoint: await this.serde.loadsTyped(
        row.checkpoint_type,
        Buffer.from(row.checkpoint_data, "base64"),
      ),
      metadata: await this.serde.loadsTyped(
        row.metadata_type,
        Buffer.from(row.metadata_data, "base64"),
      ),
      ...(row.parent_checkpoint_id
        ? { parentConfig: this.config(row.parent_checkpoint_id) }
        : {}),
      pendingWrites: await Promise.all(
        writes.map(
          async (w) =>
            [
              w.task_id,
              w.channel,
              await this.serde.loadsTyped(
                w.value_type,
                Buffer.from(w.value_data, "base64"),
              ),
            ] as [string, string, unknown],
        ),
      ),
    };
  }
  async *list(
    config: Config,
    options?: Parameters<BaseCheckpointSaver["list"]>[1],
  ): AsyncGenerator<CheckpointTuple> {
    this.identity(config);
    if (options?.before) this.identity(options.before);
    const rows = (
      await this.db.query(
        "SELECT checkpoint_id FROM analysis_checkpoints WHERE analysis_attempt_id=$1 ORDER BY checkpoint_id DESC",
        [this.analysisId],
      )
    ).rows;
    let count = 0;
    for (const row of rows) {
      if (
        options?.before?.configurable?.checkpoint_id &&
        row.checkpoint_id >= options.before.configurable.checkpoint_id
      )
        continue;
      const tuple = await this.getTuple(this.config(row.checkpoint_id));
      if (
        !tuple ||
        (options?.filter &&
          Object.entries(options.filter).some(
            ([k, v]) =>
              JSON.stringify((tuple.metadata as any)?.[k]) !==
              JSON.stringify(v),
          ))
      )
        continue;
      if (options?.limit !== undefined && count >= options.limit) break;
      count++;
      yield tuple;
    }
  }
  async put(
    ...[config, checkpoint, metadata]: Parameters<BaseCheckpointSaver["put"]>
  ): Promise<Config> {
    this.identity(config);
    const commit = this.persistCheckpoint(config, checkpoint, metadata);
    // Register before serialization yields. LangGraph may dispatch pending writes
    // while the initial checkpoint is still being saved, even with sync durability.
    this.checkpointCommits.set(checkpoint.id, commit);
    void commit.catch(() => {}); // The returned promise still rejects to the caller.
    return commit;
  }
  private async persistCheckpoint(
    config: Config,
    checkpoint: Parameters<BaseCheckpointSaver["put"]>[1],
    metadata: Parameters<BaseCheckpointSaver["put"]>[2],
  ): Promise<Config> {
    const [ct, cb] = await this.serde.dumpsTyped(checkpoint),
      [mt, mb] = await this.serde.dumpsTyped(metadata);
    if (cb.byteLength + mb.byteLength > 256 * 1024)
      throw new Error("CHECKPOINT_TOO_LARGE");
    await this.db.transaction(async (tx) => {
      await this.guard(tx);
      await tx.query(
        `INSERT INTO analysis_checkpoints(analysis_attempt_id,checkpoint_id,parent_checkpoint_id,checkpoint_type,checkpoint_data,metadata_type,metadata_data)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(analysis_attempt_id,checkpoint_id) DO NOTHING`,
        [
          this.analysisId,
          checkpoint.id,
          config.configurable?.checkpoint_id ?? null,
          ct,
          Buffer.from(cb).toString("base64"),
          mt,
          Buffer.from(mb).toString("base64"),
        ],
      );
    });
    return this.config(checkpoint.id);
  }
  async putWrites(
    ...[config, writes, taskId]: Parameters<BaseCheckpointSaver["putWrites"]>
  ): Promise<void> {
    this.identity(config);
    const special: Record<string, number> = {
      __error__: -1,
      __scheduled__: -2,
      __interrupt__: -3,
      __resume__: -4,
    };
    const encoded = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        return {
          channel,
          index: special[channel] ?? index,
          type,
          data: Buffer.from(bytes).toString("base64"),
        };
      }),
    );
    if (Buffer.byteLength(JSON.stringify(encoded)) > 384 * 1024)
      throw new Error("CHECKPOINT_TOO_LARGE");
    const parent = this.checkpointCommits.get(config.configurable?.checkpoint_id);
    if (parent) await parent;
    await this.db.transaction(async (tx) => {
      await this.guard(tx);
      for (const w of encoded)
        await tx.query(
          `INSERT INTO analysis_checkpoint_writes(analysis_attempt_id,checkpoint_id,task_id,write_index,channel,value_type,value_data)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(analysis_attempt_id,checkpoint_id,task_id,write_index) ${w.index < 0 ? "DO UPDATE SET channel=EXCLUDED.channel,value_type=EXCLUDED.value_type,value_data=EXCLUDED.value_data" : "DO NOTHING"}`,
          [
            this.analysisId,
            config.configurable?.checkpoint_id,
            taskId,
            w.index,
            w.channel,
            w.type,
            w.data,
          ],
        );
    });
  }
  async deleteThread(_threadId: string): Promise<void> {
    throw new Error("CHECKPOINT_AUDIT_DELETE_FORBIDDEN");
  }
}
