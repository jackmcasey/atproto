import AtpApi, { ServiceClient as AtpServiceClient } from '@atproto/api'
import { AtUri } from '@atproto/uri'
import {
  adminAuth,
  CloseFn,
  forSnapshot,
  runTestServer,
  TestServerInfo,
} from './_util'
import { SeedClient } from './seeds/client'
import basicSeed from './seeds/basic'
import {
  ACKNOWLEDGE,
  FLAG,
  TAKEDOWN,
} from '../src/lexicon/types/com/atproto/admin/moderationAction'
import { OTHER, SPAM } from '../src/lexicon/types/com/atproto/report/reasonType'

describe('moderation', () => {
  let server: TestServerInfo
  let close: CloseFn
  let client: AtpServiceClient
  let sc: SeedClient

  beforeAll(async () => {
    server = await runTestServer({
      dbPostgresSchema: 'moderation',
    })
    close = server.close
    client = AtpApi.service(server.url)
    sc = new SeedClient(client)
    await basicSeed(sc)
  })

  afterAll(async () => {
    await close()
  })

  describe('reporting', () => {
    it('creates reports of a repo.', async () => {
      const { data: reportA } = await client.com.atproto.report.create(
        {
          reasonType: SPAM,
          subject: {
            $type: 'com.atproto.repo.repoRef',
            did: sc.dids.bob,
          },
        },
        { headers: sc.getHeaders(sc.dids.alice), encoding: 'application/json' },
      )
      const { data: reportB } = await client.com.atproto.report.create(
        {
          reasonType: OTHER,
          reason: 'impersonation',
          subject: {
            $type: 'com.atproto.repo.repoRef',
            did: sc.dids.bob,
          },
        },
        { headers: sc.getHeaders(sc.dids.carol), encoding: 'application/json' },
      )
      expect(forSnapshot([reportA, reportB])).toMatchSnapshot()
    })

    it("fails reporting a repo that doesn't exist.", async () => {
      const promise = client.com.atproto.report.create(
        {
          reasonType: SPAM,
          subject: {
            $type: 'com.atproto.repo.repoRef',
            did: 'did:plc:unknown',
          },
        },
        { headers: sc.getHeaders(sc.dids.alice), encoding: 'application/json' },
      )
      await expect(promise).rejects.toThrow('Repo not found')
    })

    it('creates reports of a record.', async () => {
      const postA = sc.posts[sc.dids.bob][0].ref
      const postB = sc.posts[sc.dids.bob][1].ref
      const { data: reportA } = await client.com.atproto.report.create(
        {
          reasonType: SPAM,
          subject: {
            $type: 'com.atproto.repo.recordRef',
            uri: postA.uri.toString(),
          },
        },
        { headers: sc.getHeaders(sc.dids.alice), encoding: 'application/json' },
      )
      const { data: reportB } = await client.com.atproto.report.create(
        {
          reasonType: OTHER,
          reason: 'defamation',
          subject: {
            $type: 'com.atproto.repo.recordRef',
            uri: postB.uri.toString(),
            cid: postB.cidStr,
          },
        },
        { headers: sc.getHeaders(sc.dids.carol), encoding: 'application/json' },
      )
      expect(forSnapshot([reportA, reportB])).toMatchSnapshot()
    })

    it("fails reporting a record that doesn't exist.", async () => {
      const postA = sc.posts[sc.dids.bob][0].ref
      const postB = sc.posts[sc.dids.bob][1].ref
      const postUriBad = new AtUri(postA.uriStr)
      postUriBad.rkey = 'badrkey'

      const promiseA = client.com.atproto.report.create(
        {
          reasonType: SPAM,
          subject: {
            $type: 'com.atproto.repo.recordRef',
            uri: postUriBad.toString(),
          },
        },
        { headers: sc.getHeaders(sc.dids.alice), encoding: 'application/json' },
      )
      await expect(promiseA).rejects.toThrow('Record not found')

      const promiseB = client.com.atproto.report.create(
        {
          reasonType: OTHER,
          reason: 'defamation',
          subject: {
            $type: 'com.atproto.repo.recordRef',
            uri: postB.uri.toString(),
            cid: postA.cidStr, // bad cid
          },
        },
        { headers: sc.getHeaders(sc.dids.carol), encoding: 'application/json' },
      )
      await expect(promiseB).rejects.toThrow('Record not found')
    })
  })

  describe('actioning', () => {
    it('resolves reports on repos and records.', async () => {
      const { data: reportA } = await client.com.atproto.report.create(
        {
          reasonType: SPAM,
          subject: {
            $type: 'com.atproto.repo.repoRef',
            did: sc.dids.bob,
          },
        },
        { headers: sc.getHeaders(sc.dids.alice), encoding: 'application/json' },
      )
      const post = sc.posts[sc.dids.bob][1].ref
      const { data: reportB } = await client.com.atproto.report.create(
        {
          reasonType: OTHER,
          reason: 'defamation',
          subject: {
            $type: 'com.atproto.repo.recordRef',
            uri: post.uri.toString(),
          },
        },
        { headers: sc.getHeaders(sc.dids.carol), encoding: 'application/json' },
      )
      const { data: action } =
        await client.com.atproto.admin.takeModerationAction(
          {
            action: TAKEDOWN,
            subject: {
              $type: 'com.atproto.repo.repoRef',
              did: sc.dids.bob,
            },
            createdBy: 'X',
            reason: 'Y',
          },
          {
            encoding: 'application/json',
            headers: { authorization: adminAuth() },
          },
        )
      const { data: actionResolvedReports } =
        await client.com.atproto.admin.resolveModerationReports(
          {
            actionId: action.id,
            reportIds: [reportB.id, reportA.id],
            createdBy: 'X',
          },
          {
            encoding: 'application/json',
            headers: { authorization: adminAuth() },
          },
        )

      expect(forSnapshot(actionResolvedReports)).toMatchSnapshot()

      // Cleanup
      await client.com.atproto.admin.reverseModerationAction(
        {
          id: action.id,
          createdBy: 'X',
          reason: 'Y',
        },
        {
          encoding: 'application/json',
          headers: { authorization: adminAuth() },
        },
      )
    })

    it('does not resolve report for mismatching repo.', async () => {
      const { data: report } = await client.com.atproto.report.create(
        {
          reasonType: SPAM,
          subject: {
            $type: 'com.atproto.repo.repoRef',
            did: sc.dids.bob,
          },
        },
        { headers: sc.getHeaders(sc.dids.alice), encoding: 'application/json' },
      )
      const { data: action } =
        await client.com.atproto.admin.takeModerationAction(
          {
            action: TAKEDOWN,
            subject: {
              $type: 'com.atproto.repo.repoRef',
              did: sc.dids.carol,
            },
            createdBy: 'X',
            reason: 'Y',
          },
          {
            encoding: 'application/json',
            headers: { authorization: adminAuth() },
          },
        )

      const promise = client.com.atproto.admin.resolveModerationReports(
        {
          actionId: action.id,
          reportIds: [report.id],
          createdBy: 'X',
        },
        {
          encoding: 'application/json',
          headers: { authorization: adminAuth() },
        },
      )

      await expect(promise).rejects.toThrow(
        'Report 7 cannot be resolved by action',
      )

      // Cleanup
      await client.com.atproto.admin.reverseModerationAction(
        {
          id: action.id,
          createdBy: 'X',
          reason: 'Y',
        },
        {
          encoding: 'application/json',
          headers: { authorization: adminAuth() },
        },
      )
    })

    it('does not resolve report for mismatching record.', async () => {
      const postUri1 = sc.posts[sc.dids.alice][0].ref.uri
      const postUri2 = sc.posts[sc.dids.bob][0].ref.uri
      const { data: report } = await client.com.atproto.report.create(
        {
          reasonType: SPAM,
          subject: {
            $type: 'com.atproto.repo.recordRef',
            uri: postUri1.toString(),
          },
        },
        { headers: sc.getHeaders(sc.dids.alice), encoding: 'application/json' },
      )
      const { data: action } =
        await client.com.atproto.admin.takeModerationAction(
          {
            action: TAKEDOWN,
            subject: {
              $type: 'com.atproto.repo.recordRef',
              uri: postUri2.toString(),
            },
            createdBy: 'X',
            reason: 'Y',
          },
          {
            encoding: 'application/json',
            headers: { authorization: adminAuth() },
          },
        )

      const promise = client.com.atproto.admin.resolveModerationReports(
        {
          actionId: action.id,
          reportIds: [report.id],
          createdBy: 'X',
        },
        {
          encoding: 'application/json',
          headers: { authorization: adminAuth() },
        },
      )

      await expect(promise).rejects.toThrow(
        'Report 8 cannot be resolved by action',
      )

      // Cleanup
      await client.com.atproto.admin.reverseModerationAction(
        {
          id: action.id,
          createdBy: 'X',
          reason: 'Y',
        },
        {
          encoding: 'application/json',
          headers: { authorization: adminAuth() },
        },
      )
    })

    it('supports flagging and acknowledging.', async () => {
      const postRef1 = sc.posts[sc.dids.alice][0].ref
      const postRef2 = sc.posts[sc.dids.bob][0].ref
      const { data: action1 } =
        await client.com.atproto.admin.takeModerationAction(
          {
            action: FLAG,
            subject: {
              $type: 'com.atproto.repo.recordRef',
              uri: postRef1.uri.toString(),
            },
            createdBy: 'X',
            reason: 'Y',
          },
          {
            encoding: 'application/json',
            headers: { authorization: adminAuth() },
          },
        )
      expect(action1).toEqual(
        expect.objectContaining({
          action: FLAG,
          subject: {
            $type: 'com.atproto.repo.strongRef',
            uri: postRef1.uriStr,
            cid: postRef1.cidStr,
          },
        }),
      )
      const { data: action2 } =
        await client.com.atproto.admin.takeModerationAction(
          {
            action: ACKNOWLEDGE,
            subject: {
              $type: 'com.atproto.repo.recordRef',
              uri: postRef2.uri.toString(),
            },
            createdBy: 'X',
            reason: 'Y',
          },
          {
            encoding: 'application/json',
            headers: { authorization: adminAuth() },
          },
        )
      expect(action2).toEqual(
        expect.objectContaining({
          action: ACKNOWLEDGE,
          subject: {
            $type: 'com.atproto.repo.strongRef',
            uri: postRef2.uriStr,
            cid: postRef2.cidStr,
          },
        }),
      )
      // Cleanup
      await client.com.atproto.admin.reverseModerationAction(
        {
          id: action1.id,
          createdBy: 'X',
          reason: 'Y',
        },
        {
          encoding: 'application/json',
          headers: { authorization: adminAuth() },
        },
      )
      await client.com.atproto.admin.reverseModerationAction(
        {
          id: action2.id,
          createdBy: 'X',
          reason: 'Y',
        },
        {
          encoding: 'application/json',
          headers: { authorization: adminAuth() },
        },
      )
    })
  })
})
