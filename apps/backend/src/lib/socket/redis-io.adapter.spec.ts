import type { INestApplicationContext } from '@nestjs/common'
import { createAdapter } from '@socket.io/redis-adapter'
import { createClient } from 'redis'
import { RedisIoAdapter } from './redis-io.adapter'

jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: jest.fn(),
}))

jest.mock('redis', () => ({
  createClient: jest.fn(),
}))

describe('RedisIoAdapter', () => {
  const createRedisClient = () => ({
    connect: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn(),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
    isOpen: true,
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('REDIS_URL이 없으면 단일 서버용 in-memory adapter를 유지해야 한다', async () => {
    const adapter = new RedisIoAdapter({} as INestApplicationContext)

    await expect(adapter.connectToRedis(undefined)).resolves.toBe(false)
    expect(createClient).not.toHaveBeenCalled()
    expect(createAdapter).not.toHaveBeenCalled()
  })

  it('publisher와 subscriber 연결 후 Socket.IO Redis adapter를 생성해야 한다', async () => {
    const pubClient = createRedisClient()
    const subClient = createRedisClient()
    pubClient.duplicate.mockReturnValue(subClient)
    jest.mocked(createClient).mockReturnValue(pubClient as never)
    jest.mocked(createAdapter).mockReturnValue(jest.fn() as never)
    const adapter = new RedisIoAdapter({} as INestApplicationContext)

    await expect(adapter.connectToRedis('redis://localhost:6379')).resolves.toBe(true)

    expect(pubClient.connect).toHaveBeenCalledTimes(1)
    expect(subClient.connect).toHaveBeenCalledTimes(1)
    expect(createAdapter).toHaveBeenCalledWith(pubClient, subClient)

    await adapter.disconnectFromRedis()
    expect(pubClient.quit).toHaveBeenCalledTimes(1)
    expect(subClient.quit).toHaveBeenCalledTimes(1)
  })

  it('Redis 연결에 실패하면 열린 연결을 정리하고 오류를 전파해야 한다', async () => {
    const pubClient = createRedisClient()
    const subClient = createRedisClient()
    subClient.connect.mockRejectedValue(new Error('redis unavailable'))
    pubClient.duplicate.mockReturnValue(subClient)
    jest.mocked(createClient).mockReturnValue(pubClient as never)
    const adapter = new RedisIoAdapter({} as INestApplicationContext)

    await expect(adapter.connectToRedis('redis://localhost:6379')).rejects.toThrow('redis unavailable')
    expect(pubClient.quit).toHaveBeenCalledTimes(1)
    expect(subClient.quit).toHaveBeenCalledTimes(1)
  })
})
