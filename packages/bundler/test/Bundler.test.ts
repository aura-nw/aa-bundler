import { JsonRpcProvider, TransactionRequest } from '@ethersproject/providers'
import { Signer, Wallet, ethers, utils } from 'ethers'
import {
  IEntryPoint,
  SimpleAccount,
  SimpleAccount__factory,
  SimpleAccountFactory,
  SimpleAccountFactory__factory,
  ISimpleAccountFactory,
  IEntryPoint__factory,
  UserOperation,
  IEntryPointSimulations,
  IEntryPointSimulations__factory,
} from '@account-abstraction/utils'
import axios from 'axios'
import { ValidationManager } from '@account-abstraction/validation-manager'
import { UserOpMethodHandler } from '../src/UserOpMethodHandler'
import { arrayify, hexlify, parseEther, keccak256, getCreate2Address, defaultAbiCoder } from 'ethers/lib/utils'
import { ecsign, toRpcSig, keccak256 as keccak256_buffer } from 'ethereumjs-util'
import { getUserOpHash, sleep } from '@account-abstraction/utils'
import { packUserOp, resolveHexlify } from '../../utils'
import swaprouterjson from '../src/abi/swaprouter.json'
import wauraAbiJson from '../src/abi/waura.json'

describe('BundlerSendOP', function () {
  let provider: JsonRpcProvider
  let owner: string
  let wallet: Wallet
  let signer: Signer
  let entryPoint: IEntryPoint
  let entryPointAddress: string
  let smartAccount: SimpleAccount
  let smartAccountAddress: string
  let entryPointSimulationAddress: string
  let entryPointSimulation: IEntryPointSimulations
  let smartAccountFactoryAddress: string
  let smartAccountFactory: SimpleAccountFactory
  const rpcUrl = process.env.NETWORK_RPC || ''
  const chainId = process.env.CHAIN_ID || '6321'
  const key = 1

  before(async function () {
    provider = new ethers.providers.JsonRpcProvider(process.env.NETWORK_RPC)
    const mnemonic = process.env.MNEMONIC_TEST || ''
    wallet = ethers.Wallet.fromMnemonic(mnemonic)
    signer = wallet.connect(provider)
    owner = process.env.OWNER || ''
    entryPointAddress = process.env.ENTRYPOINT_ADDRESS || ''
    entryPoint = IEntryPoint__factory.connect(entryPointAddress, signer)
    smartAccountFactoryAddress = process.env.SAFACTORY_ADDRESS || ''
    smartAccountFactory = SimpleAccountFactory__factory.connect(smartAccountFactoryAddress, signer)
    const createAccountRes = await smartAccountFactory.createAccount(owner, '2432342342324234324234324234243223218')
    let res = await createAccountRes.wait()
    smartAccountAddress = await getSAAddress(res, rpcUrl)
    smartAccount = SimpleAccount__factory.connect(smartAccountAddress, provider)

    // prefund SA
    if ((await provider.getBalance(smartAccountAddress)) < parseEther('0.1')) {
      console.log('prefund account')
      const res = await signer.sendTransaction({ to: smartAccountAddress, value: parseEther('0.3') })
      await res.wait()

      // deposit to EntryPoint
      await entryPoint.depositTo(smartAccountAddress, { value: parseEther('0.1') })
    }
  })

  it('op swap should be sent success', async function () {
    const params = {
      tokenIn: '0x3e40f60fcbef03198e845a8bb2ca7734dda6369c',
      tokenOut: '0x36572D4A569316f9841f8094d9BC343F18f5659a',
      fee: 3000, // Example fee tier
      recipient: smartAccountAddress,
      deadline: Math.floor(Date.now() / 1000) + 60, // 1 minutes from now
      amountIn: ethers.utils.parseUnits('0.1', 18), // 1 tokenIn
      amountOutMinimum: 0, // Example value
      sqrtPriceLimitX96: 0, // Example value, usually 0 for no limit
    }

    const wauraInterface = new ethers.utils.Interface(wauraAbiJson)
    const approveCallData = wauraInterface.encodeFunctionData('approve', [
      '0x728f272ba72BaB7757D1d12054770edfF6c8d1AE',
      params.amountIn,
    ])

    const res = await sendOp([params.tokenIn, 0, approveCallData])
    console.log('Approve res', res)

    const routerInterface = new ethers.utils.Interface(swaprouterjson.abi)
    const swapCallData = routerInterface.encodeFunctionData('exactInputSingle', [params])
    const res1 = await sendOp(['0x728f272ba72BaB7757D1d12054770edfF6c8d1AE', 0, swapCallData], 1)
    console.log('Swap res', res1)
  })

  it('op transfer should be sent success', async function () {
    const res = await sendOp(['0xF4FC193579bCdA3172Fb7C49610e831b033D8d10', '10000000000000000', '0x'])
    console.log('transfer res', res)
  })

  it('Should deploy Smart account success', async () => {
    // const salt = generateRandomString(20, '0123456789')
    const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('luongdeptrai1'))
    // utils.AbiCoder.
    console.log('salt', salt)
    console.log('owner', owner)
    const createAccountRes = await smartAccountFactory.createAccount(owner, salt)
    let res = await createAccountRes.wait()
    const smartAccountAddress = getSAAddress(res, rpcUrl)
    console.log('smartAccountAddress', smartAccountAddress)

    // const create2Address = calculateCreate2Address(
    //   smartAccountFactoryAddress,
    //   salt,
    //   SimpleAccountFactory__factory.bytecode
    // )
    // console.log('create2Address', create2Address)

    const initCode = ethers.utils.defaultAbiCoder.encode(
      ['address', 'bytes'],
      [smartAccountFactoryAddress, createAccountRes.data]
    )
    try {
      const getRes = await entryPoint.getSenderAddress(initCode, { gasLimit: 10000000 })
      res = await getRes.wait()
      console.log('res', res)
    } catch (err) {
      console.log('err', err)
    }
  })

  async function sendOp(params: any[], nonceIncre: number = 0) {
    const executeCallData = smartAccount.interface.encodeFunctionData('execute', params)
    if (executeCallData === undefined) {
      return
    }
    console.log('nonceIncre', nonceIncre)
    let sequenceNumber = await smartAccount.getNonce()
    sequenceNumber = sequenceNumber.add(nonceIncre)
    console.log('sequenceNumber', sequenceNumber)
    const nonce = await entryPoint.getNonce(smartAccountAddress, sequenceNumber)
    console.log('nonce', nonce)

    let op: UserOperation = {
      sender: smartAccountAddress,
      nonce,
      callData: executeCallData,
      callGasLimit: 500000,
      verificationGasLimit: 200000,
      preVerificationGas: 50000,
      maxFeePerGas: 1000000000,
      maxPriorityFeePerGas: 1000000000,
      signature: '',
    }

    const signUserOp = async (
      op: UserOperation,
      signer: Wallet,
      entryPoint: string,
      chainId: number
    ): Promise<UserOperation> => {
      const message = getUserOpHash(op, entryPoint, chainId)
      const signature = await signer.signMessage(arrayify(message))

      return {
        ...op,
        signature,
      }
    }
    const signedOp = await signUserOp(op, wallet, entryPointAddress, chainId)
    const hexlifiedOp = await resolveHexlify(signedOp)

    const options = {
      method: 'POST',
      url: process.env.BUNDLER_URL,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendUserOperation',
        params: [hexlifiedOp, entryPointAddress],
      },
    }
    const res = await axios
      .request(options)
      .then(function (response) {
        return response.data
      })
      .catch(function (error) {
        console.log('BundlerTest error', error)
      })

    return res
  }
})

async function getSAAddress(createAccountRes: ethers.ContractReceipt, rpcUrl: string): Promise<string> {
  const debugTxResult = await axios.post(rpcUrl, {
    method: 'debug_traceTransaction',
    params: [
      createAccountRes.transactionHash,
      {
        tracer: 'callTracer',
      },
    ],
    id: 1,
    jsonrpc: '2.0',
  })
  return debugTxResult.data.result.output.replace('000000000000000000000000', '')
}

function generateRandomString(length: number, charset: string): string {
  // const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  const charactersLength = charset.length

  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charactersLength)
    result += charset.charAt(randomIndex)
  }

  return result
}

function calculateCreate2Address(factoryAddress: string, salt: string, smartAccountBytecode: string) {
  return getCreate2Address(factoryAddress, salt, ethers.utils.keccak256(smartAccountBytecode))
}
