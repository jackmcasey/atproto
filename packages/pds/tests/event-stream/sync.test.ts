import { sql } from 'kysely'
import AtpApi, { ServiceClient as AtpServiceClient } from '@atproto/api'
import { getWriteLog, RecordWriteOp, WriteOpAction } from '@atproto/repo'
import SqlRepoStorage from '../../src/sql-repo-storage'
import basicSeed from '../seeds/basic'
import { SeedClient } from '../seeds/client'
import { forSnapshot, runTestServer, TestServerInfo } from '../_util'
import {
  prepareCreate,
  prepareDelete,
  prepareUpdate,
  PreparedWrite,
} from '../../src/repo'
import { AppContext } from '../../src'

describe('sync', () => {
  let server: TestServerInfo
  let ctx: AppContext
  let client: AtpServiceClient
  let sc: SeedClient

  beforeAll(async () => {
    server = await runTestServer({
      dbPostgresSchema: 'event_stream_sync',
    })
    ctx = server.ctx
    client = AtpApi.service(server.url)
    sc = new SeedClient(client)
    await basicSeed(sc, ctx.messageQueue)
  })

  afterAll(async () => {
    await server.close()
  })

  it('rebuilds timeline indexes from repo state.', async () => {
    const { db, services, messageQueue } = ctx
    const { ref } = db.db.dynamic
    // Destroy indexes
    await Promise.all(
      indexedTables.map((t) => sql`delete from ${ref(t)}`.execute(db.db)),
    )
    // Confirm timeline empty
    const emptiedTL = await client.app.bsky.feed.getTimeline(
      {},
      { headers: sc.getHeaders(sc.dids.alice) },
    )
    expect(emptiedTL.data.feed).toEqual([])
    // Compute oplog from state of all repos
    const repoOpLogs = await Promise.all(
      Object.entries(sc.dids)
        .sort(([nameA], [nameB]) => nameA.localeCompare(nameB)) // Order for test determinism
        .map(([, did]) => did)
        .map(async (did) => ({
          did,
          opLog: await getOpLog(did),
        })),
    )
    const indexOps = repoOpLogs.flatMap(({ did, opLog }) =>
      opLog.map((ops) => ({ did, ops })),
    )
    // Run oplog through indexers
    let ts = Date.now() // Increment for test determinism
    for (const op of indexOps) {
      const now = new Date(ts++).toISOString()
      const writes = await prepareWrites(op.did, op.ops)
      await db.transaction((dbTxn) =>
        services.repo(dbTxn).indexWrites(writes, now),
      )
    }
    await messageQueue.processAll()
    // Check indexed timeline
    const aliceTL = await client.app.bsky.feed.getTimeline(
      {},
      { headers: sc.getHeaders(sc.dids.alice) },
    )
    expect(forSnapshot(aliceTL.data.feed)).toMatchSnapshot()
  })

  async function getOpLog(did: string) {
    const { db } = ctx
    const storage = new SqlRepoStorage(db, did)
    const root = await storage.getHead()
    if (!root) throw new Error('Missing repo root')
    return await getWriteLog(storage, root, null)
  }

  function prepareWrites(
    did: string,
    ops: RecordWriteOp[],
  ): Promise<PreparedWrite[]> {
    return Promise.all(
      ops.map((op) => {
        const { action } = op
        if (action === WriteOpAction.Create) {
          return prepareCreate({
            did,
            collection: op.collection,
            rkey: op.rkey,
            record: op.record,
          })
        } else if (action === WriteOpAction.Update) {
          return prepareUpdate({
            did,
            collection: op.collection,
            rkey: op.rkey,
            record: op.record,
          })
        } else if (action === WriteOpAction.Delete) {
          return prepareDelete({
            did,
            collection: op.collection,
            rkey: op.rkey,
          })
        } else {
          const exhaustiveCheck: never = action
          throw new Error(`Unhandled case: ${exhaustiveCheck}`)
        }
      }),
    )
  }

  const indexedTables = [
    'record',
    'duplicate_record',
    'user_notification',
    'assertion',
    'profile',
    'follow',
    'post',
    'post_entity',
    'post_embed_image',
    'post_embed_external',
    'repost',
    'vote',
    /* Not these:
     * 'ipld_block',
     * 'ipld_block_creator',
     * 'blob',
     * 'repo_blob',
     * 'user',
     * 'did_handle',
     * 'refresh_token',
     * 'repo_root',
     * 'invite_code',
     * 'invite_code_use',
     * 'message_queue',
     * 'message_queue_cursor',
     */
  ]
})
