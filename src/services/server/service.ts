/* Imports: External */
import { BaseService } from '@eth-optimism/service-base'
import express, { Request, Response } from 'express'
import cors from 'cors'
import { BigNumber } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'

/* Imports: Internal */
import { TransportDB } from '../../db/transport-db'
import {
  ContextResponse,
  EnqueueResponse,
  StateRootBatchResponse,
  StateRootResponse,
  SyncingResponse,
  TransactionBatchResponse,
  TransactionResponse,
} from '../../types'
import { validators } from '../../utils'

export interface L1TransportServerOptions {
  db: any
  port: number
  hostname: string
  confirmations: number
  l1RpcProvider: string | JsonRpcProvider
  showUnconfirmedTransactions: boolean
}

export class L1TransportServer extends BaseService<L1TransportServerOptions> {
  protected name = 'L1 Transport Server'
  protected optionSettings = {
    db: {
      validate: validators.isLevelUP,
    },
    port: {
      default: 7878,
      validate: validators.isInteger,
    },
    hostname: {
      default: 'localhost',
      validate: validators.isString,
    },
    confirmations: {
      validate: validators.isInteger,
    },
    l1RpcProvider: {
      validate: (val: any) => {
        return validators.isUrl(val) || validators.isJsonRpcProvider(val)
      },
    },
    showUnconfirmedTransactions: {
      validate: validators.isBoolean,
    },
  }

  private state: {
    app: express.Express
    server: any
    db: TransportDB
    l1RpcProvider: JsonRpcProvider
  } = {} as any

  protected async _init(): Promise<void> {
    // TODO: I don't know if this is strictly necessary, but it's probably a good thing to do.
    if (!this.options.db.isOpen()) {
      await this.options.db.open()
    }

    this.state.db = new TransportDB(this.options.db)
    this.state.l1RpcProvider =
      typeof this.options.l1RpcProvider === 'string'
        ? new JsonRpcProvider(this.options.l1RpcProvider)
        : this.options.l1RpcProvider

    this._initializeApp()
  }

  protected async _start(): Promise<void> {
    this.state.server = this.state.app.listen(
      this.options.port,
      this.options.hostname
    )
    this.logger.info(`Server listening on port: ${this.options.port}`)
  }

  protected async _stop(): Promise<void> {
    this.state.server.close()
  }

  /**
   * Initializes the server application.
   * Do any sort of initialization here that you want. Mostly just important that
   * `_registerAllRoutes` is called at the end.
   */
  private _initializeApp() {
    // TODO: Maybe pass this in as a parameter instead of creating it here?
    this.state.app = express()
    this.state.app.use(cors())
    this._registerAllRoutes()
  }

  /**
   * Registers a route on the server.
   * @param method Http method type.
   * @param route Route to register.
   * @param handler Handler called and is expected to return a JSON response.
   */
  private _registerRoute(
    method: 'get', // Just handle GET for now, but could extend this with whatever.
    route: string,
    handler: (req?: Request, res?: Response) => Promise<any>
  ): void {
    // TODO: Better typing on the return value of the handler function.
    // TODO: Check for route collisions.
    // TODO: Add a different function to allow for removing routes.

    this.state.app[method](route, async (req, res) => {
      try {
        this.logger.info(`${req.ip}: ${method.toUpperCase()} ${req.path}`)
        return res.json(await handler(req, res))
      } catch (e) {
        return res.status(400).json({
          error: e.toString(),
        })
      }
    })
  }

  /**
   * Registers all of the server routes we want to expose.
   * TODO: Link to our API spec.
   */
  private _registerAllRoutes(): void {
    // TODO: Maybe add doc-like comments to each of these routes?

    this._registerRoute(
      'get',
      '/eth/syncing',
      async (): Promise<SyncingResponse> => {
        const highestL2BlockNumber = await this.state.db.getHighestL2BlockNumber()
        const currentL2Block = await this.state.db.getLatestTransaction()

        if (currentL2Block === null) {
          if (highestL2BlockNumber === null) {
            return {
              syncing: false,
              currentTransactionIndex: 0,
            }
          } else {
            return {
              syncing: true,
              highestKnownTransactionIndex: highestL2BlockNumber,
              currentTransactionIndex: 0,
            }
          }
        }

        if (highestL2BlockNumber > currentL2Block.index) {
          return {
            syncing: true,
            highestKnownTransactionIndex: highestL2BlockNumber,
            currentTransactionIndex: currentL2Block.index,
          }
        } else {
          return {
            syncing: false,
            currentTransactionIndex: currentL2Block.index,
          }
        }
      }
    )

    this._registerRoute(
      'get',
      '/eth/context/latest',
      async (): Promise<ContextResponse> => {
        const tip = await this.state.l1RpcProvider.getBlockNumber()
        const blockNumber = Math.max(0, tip - this.options.confirmations)

        const block = await this.state.l1RpcProvider.getBlock(blockNumber)

        return {
          blockNumber: block.number,
          timestamp: block.timestamp,
          blockHash: block.hash,
        }
      }
    )

    this._registerRoute(
      'get',
      '/eth/context/blocknumber/:number',
      async (req): Promise<ContextResponse> => {
        const number = BigNumber.from(req.params.number).toNumber()
        const tip = await this.state.l1RpcProvider.getBlockNumber()
        const blockNumber = Math.max(0, tip - this.options.confirmations)

        if (number > blockNumber) {
           return {
             blockNumber: null,
             timestamp: null,
             blockHash: null,
           }
        }

        const block = await this.state.l1RpcProvider.getBlock(number)
        return {
          blockNumber: block.number,
          timestamp: block.timestamp,
          blockHash: block.hash,
        }
      }
    )

    this._registerRoute(
      'get',
      '/enqueue/latest',
      async (): Promise<EnqueueResponse> => {
        const enqueue = await this.state.db.getLatestEnqueue()

        if (enqueue === null) {
          return null
        }

        const ctcIndex = await this.state.db.getTransactionIndexByQueueIndex(
          enqueue.index
        )

        return {
          ...enqueue,
          ctcIndex,
        }
      }
    )

    this._registerRoute(
      'get',
      '/enqueue/index/:index',
      async (req): Promise<EnqueueResponse> => {
        const enqueue = await this.state.db.getEnqueueByIndex(
          BigNumber.from(req.params.index).toNumber()
        )

        if (enqueue === null) {
          return null
        }

        const ctcIndex = await this.state.db.getTransactionIndexByQueueIndex(
          enqueue.index
        )

        return {
          ...enqueue,
          ctcIndex,
        }
      }
    )

    this._registerRoute(
      'get',
      '/transaction/latest',
      async (): Promise<TransactionResponse> => {
        let transaction = await this.state.db.getLatestFullTransaction()
        if (this.options.showUnconfirmedTransactions) {
          const unconfirmedTransaction = await this.state.db.getLatestFullUnconfirmedTransaction()

          if (
            unconfirmedTransaction !== null &&
            (transaction === null ||
              transaction.index < unconfirmedTransaction.index)
          ) {
            transaction = unconfirmedTransaction
          }
        }

        if (transaction === null) {
          return {
            transaction: null,
            batch: null,
          }
        }

        const batch = await this.state.db.getTransactionBatchByIndex(
          transaction.batchIndex
        )

        return {
          transaction,
          batch,
        }
      }
    )

    this._registerRoute(
      'get',
      '/transaction/index/:index',
      async (req): Promise<TransactionResponse> => {
        let transaction = await this.state.db.getFullTransactionByIndex(
          BigNumber.from(req.params.index).toNumber()
        )
        if (this.options.showUnconfirmedTransactions) {
          const unconfirmedTransaction = await this.state.db.getFullUnconfirmedTransactionByIndex(
            BigNumber.from(req.params.index).toNumber()
          )

          if (
            unconfirmedTransaction !== null &&
            (transaction === null ||
              transaction.index < unconfirmedTransaction.index)
          ) {
            transaction = unconfirmedTransaction
          }
        }

        if (transaction === null) {
          return {
            transaction: null,
            batch: null,
          }
        }

        const batch = await this.state.db.getTransactionBatchByIndex(
          transaction.batchIndex
        )

        return {
          transaction,
          batch,
        }
      }
    )

    this._registerRoute(
      'get',
      '/batch/transaction/latest',
      async (): Promise<TransactionBatchResponse> => {
        const batch = await this.state.db.getLatestTransactionBatch()

        if (batch === null) {
          return {
            batch: null,
            transactions: [],
          }
        }

        const transactions = await this.state.db.getFullTransactionsByIndexRange(
          BigNumber.from(batch.prevTotalElements).toNumber(),
          BigNumber.from(batch.prevTotalElements).toNumber() +
            BigNumber.from(batch.size).toNumber()
        )

        return {
          batch,
          transactions,
        }
      }
    )

    this._registerRoute(
      'get',
      '/batch/transaction/index/:index',
      async (req): Promise<TransactionBatchResponse> => {
        const batch = await this.state.db.getTransactionBatchByIndex(
          BigNumber.from(req.params.index).toNumber()
        )

        if (batch === null) {
          return {
            batch: null,
            transactions: [],
          }
        }

        const transactions = await this.state.db.getFullTransactionsByIndexRange(
          BigNumber.from(batch.prevTotalElements).toNumber(),
          BigNumber.from(batch.prevTotalElements).toNumber() +
            BigNumber.from(batch.size).toNumber()
        )

        return {
          batch,
          transactions,
        }
      }
    )

    this._registerRoute(
      'get',
      '/stateroot/latest',
      async (): Promise<StateRootResponse> => {
        let stateRoot = await this.state.db.getLatestStateRoot()
        if (this.options.showUnconfirmedTransactions) {
          const unconfirmedStateRoot = await this.state.db.getLatestUnconfirmedStateRoot()

          if (
            unconfirmedStateRoot !== null &&
            (stateRoot === null || stateRoot.index < unconfirmedStateRoot.index)
          ) {
            stateRoot = unconfirmedStateRoot
          }
        }

        if (stateRoot === null) {
          return {
            stateRoot: null,
            batch: null,
          }
        }

        const batch = await this.state.db.getStateRootBatchByIndex(
          stateRoot.batchIndex
        )

        return {
          stateRoot,
          batch,
        }
      }
    )

    this._registerRoute(
      'get',
      '/stateroot/index/:index',
      async (req): Promise<StateRootResponse> => {
        let stateRoot = await this.state.db.getStateRootByIndex(
          BigNumber.from(req.params.index).toNumber()
        )
        if (this.options.showUnconfirmedTransactions) {
          const unconfirmedStateRoot = await this.state.db.getUnconfirmedStateRootByIndex(
            BigNumber.from(req.params.index).toNumber()
          )

          if (
            unconfirmedStateRoot !== null &&
            (stateRoot === null || stateRoot.index < unconfirmedStateRoot.index)
          ) {
            stateRoot = unconfirmedStateRoot
          }
        }

        if (stateRoot === null) {
          return {
            stateRoot: null,
            batch: null,
          }
        }

        const batch = await this.state.db.getStateRootBatchByIndex(
          stateRoot.batchIndex
        )

        return {
          stateRoot,
          batch,
        }
      }
    )

    this._registerRoute(
      'get',
      '/batch/stateroot/latest',
      async (): Promise<StateRootBatchResponse> => {
        const batch = await this.state.db.getLatestStateRootBatch()

        if (batch === null) {
          return {
            batch: null,
            stateRoots: [],
          }
        }

        const stateRoots = await this.state.db.getStateRootsByIndexRange(
          BigNumber.from(batch.prevTotalElements).toNumber(),
          BigNumber.from(batch.prevTotalElements).toNumber() +
            BigNumber.from(batch.size).toNumber()
        )

        return {
          batch,
          stateRoots,
        }
      }
    )

    this._registerRoute(
      'get',
      '/batch/stateroot/index/:index',
      async (req): Promise<StateRootBatchResponse> => {
        const batch = await this.state.db.getStateRootBatchByIndex(
          BigNumber.from(req.params.index).toNumber()
        )

        if (batch === null) {
          return {
            batch: null,
            stateRoots: [],
          }
        }

        const stateRoots = await this.state.db.getStateRootsByIndexRange(
          BigNumber.from(batch.prevTotalElements).toNumber(),
          BigNumber.from(batch.prevTotalElements).toNumber() +
            BigNumber.from(batch.size).toNumber()
        )

        return {
          batch,
          stateRoots,
        }
      }
    )
  }
}
