import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import axios from "axios";

const orderProcessorDataPath = path.resolve(
  __dirname,
  "./order_processor.json"
);

const orderProcessorData = JSON.parse(
  fs.readFileSync(orderProcessorDataPath, "utf8")
);

const orderProcessorAbi = orderProcessorData.abi;

// token abi
const tokenAbi = [
  "function name() external view returns (string memory)",
  "function decimals() external view returns (uint8)",
  "function version() external view returns (string memory)",
  "function nonces(address owner) external view returns (uint256)",
];

async function getContractVersion(contract: ethers.Contract): Promise<string> {
  let contractVersion = "1";
  try {
    contractVersion = await contract.version();
  } catch {
    // do nothing
  }
  return contractVersion;
}

async function main() {
  // ------------------ Setup ------------------

  // permit EIP712 signature data type
  const permitTypes = {
    Permit: [
      {
        name: "owner",
        type: "address",
      },
      {
        name: "spender",
        type: "address",
      },
      {
        name: "value",
        type: "uint256",
      },
      {
        name: "nonce",
        type: "uint256",
      },
      {
        name: "deadline",
        type: "uint256",
      },
    ],
  };

  // setup values
  const privateKey = process.env.PRIVATE_KEY_EOA;
  if (!privateKey) throw new Error("empty key");
  const RPC_URL = process.env.RPC_URL;
  if (!RPC_URL) throw new Error("empty rpc url");
  const assetTokenAddress = process.env.ASSETTOKEN;
  if (!assetTokenAddress) throw new Error("empty asset token address");
  const paymentTokenAddress = process.env.PAYMENTTOKEN;
  if (!paymentTokenAddress) throw new Error("empty payment token address");
  const dinariApiKey = process.env.DINARI_API_KEY;
  if (!dinariApiKey) throw new Error("empty dinari api key");

  // Setup API client
  const dinariClient = axios.create({
    baseURL: "https://api-enterprise.sandbox.dinari.com",
    headers: {
      Authorization: `Bearer ${dinariApiKey}`,
      "Content-Type": "application/json",
    },
  });

  // setup provider and signer
  const provider = ethers.getDefaultProvider(RPC_URL);
  const signer = new ethers.Wallet(privateKey, provider);
  console.log(`Signer Address: ${signer.address}`);

  const chainId = Number((await provider.getNetwork()).chainId);
  console.log(`Chain ID: ${chainId}`);

  const orderProcessorAddress = orderProcessorData.networkAddresses[chainId];
  console.log(`Order Processor Address: ${orderProcessorAddress}`);

  // Setup contracts
  const paymentToken = new ethers.Contract(
    paymentTokenAddress,
    tokenAbi,
    signer
  );
  const assetToken = new ethers.Contract(assetTokenAddress, tokenAbi, signer);
  const orderProcessor = new ethers.Contract(
    orderProcessorAddress,
    orderProcessorAbi,
    signer
  );

  // ------------------ Configure Order ------------------

  const orderParams = await configureOrder(
    orderProcessor,
    assetToken,
    signer,
    assetTokenAddress,
    paymentTokenAddress
  );
  console.log("orderParams",orderParams);

  // // Get fee quote
  const { fees, feeQuoteResponse } = await getFeeQuote(
    dinariClient,
    chainId,
    orderProcessorAddress,
    orderParams
  );

  console.log("feeQuoteData", {
    chain_id: chainId,
    contract_address: orderProcessorAddress,
    order_data: orderParams,
  });

  const totalSpendAmount = BigInt(orderParams.paymentTokenQuantity) + fees;
  console.log(`fees: ${ethers.utils.formatUnits(fees, 6)}`);

  // ------------------ Configure Permit ------------------

  // sign permit
  const { permitDomain, permitMessage } = await configurePermit(
    signer,
    provider,
    paymentToken,
    orderProcessorAddress,
    totalSpendAmount
  );
  console.log("permitMessage", permitMessage);

  const permitSignatureBytes = await signer._signTypedData(
    permitDomain,
    permitTypes,
    permitMessage
  );
  const permitSignature = ethers.utils.splitSignature(permitSignatureBytes);
  console.log("permitSignature", permitSignature);

  // create selfPermit call data
  const selfPermitData = orderProcessor.interface.encodeFunctionData(
    "selfPermit",
    [
      paymentTokenAddress,
      permitMessage.owner,
      permitMessage.value,
      permitMessage.deadline,
      permitSignature.v,
      permitSignature.r,
      permitSignature.s,
    ]
  );
  console.log("selfPermitData", selfPermitData);

  // ------------------ Submit Order ------------------

  // Submit order and wait for receipt
  const receipt = await submitOrder(
    orderProcessor,
    selfPermitData,
    orderParams,
    feeQuoteResponse
  );
  console.log(`tx hash: ${receipt.transactionHash}`);

  // get order id from event
  const orderEvent = receipt.logs
    .filter(
      (log: any) =>
        log.topics[0] === orderProcessor.interface.getEventTopic("OrderCreated")
    )
    .map((log: any) => orderProcessor.interface.parseLog(log))[0];
  if (!orderEvent) throw new Error("no order event");
  const orderId = orderEvent.args[0];
  const orderAccount = orderEvent.args[1];
  console.log(`Order ID: ${orderId}`);
  console.log(`Order Account: ${orderAccount}`);

  // use order id to get order status (ACTIVE, FULFILLED, CANCELLED)
  const orderStatus = await orderProcessor.getOrderStatus(orderId);
  console.log(`Order Status: ${orderStatus}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

async function configureOrder(
  orderProcessor: ethers.Contract,
  assetToken: ethers.Contract,
  signer: ethers.Wallet,
  assetTokenAddress: string,
  paymentTokenAddress: string
) {
  // buy order amount (1 USDC)
  const orderAmount = BigInt(1_000_000);
  const sellOrder = false;
  const orderType = Number(0);
  const limitPrice = Number(0);

  // Check order precision for sell orders
  if (sellOrder) {
    await validateSellOrderPrecision(
      orderProcessor,
      assetToken,
      assetTokenAddress,
      orderAmount
    );
  }

  return {
    requestTimestamp: Date.now(),
    recipient: signer.address,
    assetToken: assetTokenAddress,
    paymentToken: paymentTokenAddress,
    sell: sellOrder,
    orderType: orderType,
    assetTokenQuantity: 0,
    paymentTokenQuantity: Number(orderAmount),
    price: limitPrice,
    tif: 1,
  };
}

async function validateSellOrderPrecision(
  orderProcessor: ethers.Contract,
  assetToken: ethers.Contract,
  assetTokenAddress: string,
  orderAmount: bigint
) {
  const allowedDecimalReduction =
    await orderProcessor.orderDecimalReduction(assetTokenAddress);
  const allowablePrecisionReduction = 10 ** allowedDecimalReduction;

  if (Number(orderAmount) % allowablePrecisionReduction != 0) {
    const assetTokenDecimals = await assetToken.decimals();
    const maxDecimals = assetTokenDecimals - allowedDecimalReduction;
    throw new Error(
      `Order amount precision exceeds max decimals of ${maxDecimals}`
    );
  }
}

async function configurePermit(
  signer: ethers.Wallet,
  provider: ethers.providers.Provider,
  paymentToken: ethers.Contract,
  orderProcessorAddress: string,
  totalSpendAmount: bigint
) {
  const nonce = await paymentToken.nonces(signer.address);
  const blockNumber = await provider.getBlockNumber();
  const blockTime = (await provider.getBlock(blockNumber))?.timestamp;
  if (!blockTime) throw new Error("no block time");
  const deadline = blockTime + 60 * 5;

  const permitDomain = {
    name: await paymentToken.name(),
    version: await getContractVersion(paymentToken),
    chainId: (await provider.getNetwork()).chainId,
    verifyingContract: paymentToken.address,
  };

  const permitMessage = {
    owner: signer.address,
    spender: orderProcessorAddress,
    value: totalSpendAmount,
    nonce: nonce,
    deadline: deadline,
  };

  return { permitDomain, permitMessage };
}

async function submitOrder(
  orderProcessor: ethers.Contract,
  selfPermitData: string,
  orderParams: any,
  feeQuoteResponse: any
) {
  const requestOrderData = orderProcessor.interface.encodeFunctionData(
    "createOrder",
    [
      [
        orderParams.requestTimestamp,
        orderParams.recipient,
        orderParams.assetToken,
        orderParams.paymentToken,
        orderParams.sell,
        orderParams.orderType,
        orderParams.assetTokenQuantity,
        orderParams.paymentTokenQuantity,
        orderParams.price,
        orderParams.tif,
      ],
      [
        feeQuoteResponse.fee_quote.orderId,
        feeQuoteResponse.fee_quote.requester,
        feeQuoteResponse.fee_quote.fee,
        feeQuoteResponse.fee_quote.timestamp,
        feeQuoteResponse.fee_quote.deadline,
      ],
      feeQuoteResponse.fee_quote_signature,
    ]
  );

  const tx = await orderProcessor.multicall([selfPermitData, requestOrderData]);
  console.log("tx", tx);
  return await tx.wait();
}

async function getFeeQuote(
  dinariClient: any,
  chainId: number,
  orderProcessorAddress: string,
  orderParams: any
) {
  const feeQuoteData = {
    chain_id: chainId,
    contract_address: orderProcessorAddress,
    order_data: orderParams,
  };
  const feeQuoteResponse = await dinariClient.post(
    "/api/v1/web3/orders/fee",
    feeQuoteData
  );
  return {
    fees: BigInt(feeQuoteResponse.data.fee_quote.fee),
    feeQuoteResponse: feeQuoteResponse.data,
  };
}
