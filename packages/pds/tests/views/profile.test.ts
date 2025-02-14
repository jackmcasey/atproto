import fs from 'fs/promises'
import AtpApi, { ServiceClient as AtpServiceClient } from '@atproto/api'
import { TAKEDOWN } from '@atproto/api/src/client/types/com/atproto/admin/moderationAction'
import { runTestServer, forSnapshot, CloseFn, adminAuth } from '../_util'
import { SeedClient } from '../seeds/client'
import basicSeed from '../seeds/basic'

describe('pds profile views', () => {
  let client: AtpServiceClient
  let close: CloseFn
  let sc: SeedClient

  // account dids, for convenience
  let alice: string
  let bob: string
  let dan: string

  beforeAll(async () => {
    const server = await runTestServer({
      dbPostgresSchema: 'views_profile',
    })
    close = server.close
    client = AtpApi.service(server.url)
    sc = new SeedClient(client)
    await basicSeed(sc)
    alice = sc.dids.alice
    bob = sc.dids.bob
    dan = sc.dids.dan
  })

  afterAll(async () => {
    await close()
  })

  it('fetches own profile', async () => {
    const aliceForAlice = await client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(alice) },
    )

    expect(forSnapshot(aliceForAlice.data)).toMatchSnapshot()
  })

  it("fetches other's profile, with a follow", async () => {
    const aliceForBob = await client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(bob) },
    )

    expect(forSnapshot(aliceForBob.data)).toMatchSnapshot()
  })

  it("fetches other's profile, without a follow", async () => {
    const danForBob = await client.app.bsky.actor.getProfile(
      { actor: dan },
      { headers: sc.getHeaders(bob) },
    )

    expect(forSnapshot(danForBob.data)).toMatchSnapshot()
  })

  it('updates profile', async () => {
    await client.app.bsky.actor.updateProfile(
      { displayName: 'ali', description: 'new descript' },
      { headers: sc.getHeaders(alice), encoding: 'application/json' },
    )

    const aliceForAlice = await client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(alice) },
    )

    expect(forSnapshot(aliceForAlice.data)).toMatchSnapshot()
  })

  it('handles partial updates', async () => {
    await client.app.bsky.actor.updateProfile(
      { description: 'blah blah' },
      { headers: sc.getHeaders(alice), encoding: 'application/json' },
    )

    const aliceForAlice = await client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(alice) },
    )

    expect(forSnapshot(aliceForAlice.data)).toMatchSnapshot()
  })

  it('handles avatars & banners', async () => {
    const avatarImg = await fs.readFile(
      'tests/image/fixtures/key-portrait-small.jpg',
    )
    const bannerImg = await fs.readFile(
      'tests/image/fixtures/key-landscape-small.jpg',
    )
    const avatarRes = await client.com.atproto.blob.upload(avatarImg, {
      headers: sc.getHeaders(alice),
      encoding: 'image/jpeg',
    })
    const bannerRes = await client.com.atproto.blob.upload(bannerImg, {
      headers: sc.getHeaders(alice),
      encoding: 'image/jpeg',
    })

    await client.app.bsky.actor.updateProfile(
      {
        avatar: { cid: avatarRes.data.cid, mimeType: 'image/jpeg' },
        banner: { cid: bannerRes.data.cid, mimeType: 'image/jpeg' },
      },
      { headers: sc.getHeaders(alice), encoding: 'application/json' },
    )

    const aliceForAlice = await client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(alice) },
    )

    expect(forSnapshot(aliceForAlice.data)).toMatchSnapshot()
  })

  it('creates new profile', async () => {
    await client.app.bsky.actor.updateProfile(
      { displayName: 'danny boy' },
      { headers: sc.getHeaders(dan), encoding: 'application/json' },
    )

    const danForDan = await client.app.bsky.actor.getProfile(
      { actor: dan },
      { headers: sc.getHeaders(dan) },
    )

    expect(forSnapshot(danForDan.data)).toMatchSnapshot()
  })

  it('handles racing updates', async () => {
    const descriptions: string[] = []
    const COUNT = 10
    for (let i = 0; i < COUNT; i++) {
      descriptions.push(`description-${i}`)
    }
    await Promise.all(
      descriptions.map(async (description) => {
        await client.app.bsky.actor.updateProfile(
          { description },
          { headers: sc.getHeaders(alice), encoding: 'application/json' },
        )
      }),
    )

    const profile = await client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(alice) },
    )

    // doesn't matter which request wins race, but one of them should win
    const descripExists = descriptions.some(
      (descrip) => profile.data.description === descrip,
    )
    expect(descripExists).toBeTruthy()
  })

  it('fetches profile by handle', async () => {
    const byDid = await client.app.bsky.actor.getProfile(
      { actor: alice },
      {
        headers: sc.getHeaders(bob),
      },
    )

    const byHandle = await client.app.bsky.actor.getProfile(
      { actor: sc.accounts[alice].handle },
      { headers: sc.getHeaders(bob) },
    )

    expect(byHandle.data).toEqual(byDid.data)
  })

  it('blocked by actor takedown', async () => {
    const { data: action } =
      await client.com.atproto.admin.takeModerationAction(
        {
          action: TAKEDOWN,
          subject: {
            $type: 'com.atproto.repo.repoRef',
            did: alice,
          },
          createdBy: 'X',
          reason: 'Y',
        },
        {
          encoding: 'application/json',
          headers: { authorization: adminAuth() },
        },
      )
    const promise = client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(bob) },
    )

    await expect(promise).rejects.toThrow('Account has been taken down')

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

  it('includes muted status.', async () => {
    const { data: initial } = await client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(bob) },
    )

    expect(initial.myState?.muted).toEqual(false)

    await client.app.bsky.graph.mute(
      { user: alice },
      { headers: sc.getHeaders(bob), encoding: 'application/json' },
    )
    const { data: muted } = await client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(bob) },
    )

    expect(muted.myState?.muted).toEqual(true)

    const { data: fromBobUnrelated } = await client.app.bsky.actor.getProfile(
      { actor: dan },
      { headers: sc.getHeaders(bob) },
    )
    const { data: toAliceUnrelated } = await client.app.bsky.actor.getProfile(
      { actor: alice },
      { headers: sc.getHeaders(dan) },
    )

    expect(fromBobUnrelated.myState?.muted).toEqual(false)
    expect(toAliceUnrelated.myState?.muted).toEqual(false)

    await client.app.bsky.graph.unmute(
      { user: alice },
      { headers: sc.getHeaders(bob), encoding: 'application/json' },
    )
  })
})
