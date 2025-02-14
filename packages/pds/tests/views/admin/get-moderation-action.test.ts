import AtpApi, { ServiceClient as AtpServiceClient } from '@atproto/api'
import {
  FLAG,
  TAKEDOWN,
} from '@atproto/api/src/client/types/com/atproto/admin/moderationAction'
import {
  OTHER,
  SPAM,
} from '../../../src/lexicon/types/com/atproto/report/reasonType'
import { runTestServer, forSnapshot, CloseFn, adminAuth } from '../../_util'
import { SeedClient } from '../../seeds/client'
import basicSeed from '../../seeds/basic'

describe('pds admin get moderation action view', () => {
  let client: AtpServiceClient
  let close: CloseFn
  let sc: SeedClient

  beforeAll(async () => {
    const server = await runTestServer({
      dbPostgresSchema: 'views_admin_get_moderation_action',
    })
    close = server.close
    client = AtpApi.service(server.url)
    sc = new SeedClient(client)
    await basicSeed(sc)
  })

  afterAll(async () => {
    await close()
  })

  beforeAll(async () => {
    const reportRepo = await sc.createReport({
      reportedByDid: sc.dids.bob,
      reasonType: SPAM,
      subject: {
        $type: 'com.atproto.repo.repoRef',
        did: sc.dids.alice,
      },
    })
    const reportRecord = await sc.createReport({
      reportedByDid: sc.dids.carol,
      reasonType: OTHER,
      reason: 'defamation',
      subject: {
        $type: 'com.atproto.repo.recordRef',
        uri: sc.posts[sc.dids.alice][0].ref.uriStr,
      },
    })
    const flagRepo = await sc.takeModerationAction({
      action: FLAG,
      subject: {
        $type: 'com.atproto.repo.repoRef',
        did: sc.dids.alice,
      },
    })
    const takedownRecord = await sc.takeModerationAction({
      action: TAKEDOWN,
      subject: {
        $type: 'com.atproto.repo.recordRef',
        uri: sc.posts[sc.dids.alice][0].ref.uriStr,
      },
    })
    await sc.resolveReports({
      actionId: flagRepo.id,
      reportIds: [reportRepo.id, reportRecord.id],
    })
    await sc.resolveReports({
      actionId: takedownRecord.id,
      reportIds: [reportRecord.id],
    })
    await sc.reverseModerationAction({ id: flagRepo.id })
  })

  it('gets moderation action for a repo.', async () => {
    const result = await client.com.atproto.admin.getModerationAction(
      { id: 1 },
      { headers: { authorization: adminAuth() } },
    )
    expect(forSnapshot(result.data)).toMatchSnapshot()
  })

  it('gets moderation action for a record.', async () => {
    const result = await client.com.atproto.admin.getModerationAction(
      { id: 2 },
      { headers: { authorization: adminAuth() } },
    )
    expect(forSnapshot(result.data)).toMatchSnapshot()
  })

  it('fails when moderation action does not exist.', async () => {
    const promise = client.com.atproto.admin.getModerationAction(
      { id: 100 },
      { headers: { authorization: adminAuth() } },
    )
    await expect(promise).rejects.toThrow('Action not found')
  })
})
