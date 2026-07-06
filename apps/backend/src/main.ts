import { RequestMethod } from '@nestjs/common'
import './instrument'
import { SwaggerConfigModule } from '@/lib/swagger/swagger.module'
import { SwaggerService } from '@/lib/swagger/swagger.service'
import { defaultValidationPipe } from '@/lib/pipes/validation.pipe'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { RedisIoAdapter } from '@/lib/socket/redis-io.adapter'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  const redisIoAdapter = new RedisIoAdapter(app)
  await redisIoAdapter.connectToRedis()
  app.useWebSocketAdapter(redisIoAdapter)
  app.enableShutdownHooks()

  app.setGlobalPrefix('api', {
    exclude: [{ path: 'metrics', method: RequestMethod.GET }],
  })

  app.useGlobalPipes(defaultValidationPipe)

  const swaggerModule = app.select(SwaggerConfigModule)
  const swaggerService = swaggerModule.get(SwaggerService)
  swaggerService.setup(app)

  await app.listen(process.env.PORT ?? 3000)
}

void bootstrap()
