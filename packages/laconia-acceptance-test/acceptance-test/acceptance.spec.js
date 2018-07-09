const frisby = require("frisby");
const uuidv4 = require("uuid/v4");
const Joi = frisby.Joi;
const DynamoDbOrderRepository = require("../src/DynamoDbOrderRepository");
const { invoke } = require("laconia-core");
const tracker = require("laconia-test-helper").tracker;

const SERVERLESS_SERVICE_NAME = "laconia-acceptance";
const SERVERLESS_STAGE = process.env.NODE_VERSION;
const prefix = `${SERVERLESS_SERVICE_NAME}-${SERVERLESS_STAGE}`;
const name = name => `${prefix}-${name}`;
const AWS = require("aws-sdk");
const documentClient = new AWS.DynamoDB.DocumentClient();

jest.setTimeout(10000);

const deleteAllItems = async tableName => {
  const params = { TableName: tableName };
  const data = await documentClient.scan(params).promise();
  for (const item of data.Items) {
    const deleteParams = {
      TableName: tableName,
      Key: { orderId: item.orderId }
    };
    await documentClient.delete(deleteParams).promise();
  }
};

const createOrder = (restaurantId, total) => ({
  restaurantId,
  customer: {
    name: "Sam"
  },
  menu: {
    food: "chicken"
  },
  paymentReference: uuidv4(),
  total
});

const placeOrder = async (url, order) => {
  const response = await frisby
    .post(url, { order })
    .expect("status", 200)
    .expect("jsonTypes", {
      orderId: Joi.string()
    });

  return response.json;
};

const getOrderUrl = async () => {
  const apig = new AWS.APIGateway();
  const restApis = await apig.getRestApis().promise();
  const restApiName = `${SERVERLESS_STAGE}-${SERVERLESS_SERVICE_NAME}`;
  const restApi = restApis.items.find(i => i.name === restApiName);
  if (!restApi) {
    throw new Error(`${restApiName} could not be found!`);
  }
  return `https://${
    restApi.id
  }.execute-api.eu-west-1.amazonaws.com/${SERVERLESS_STAGE}/order`;
};

describe("order flow", () => {
  let orderRepository;
  let orderMap;
  let orderUrl;
  const captureCardPaymentTracker = tracker(
    name("capture-card-payment"),
    name("tracker")
  );

  const calculateTotalOrderTracker = tracker(
    name("calculate-total-order"),
    name("tracker")
  );

  beforeAll(async () => {
    await deleteAllItems(name("order"));
    orderRepository = new DynamoDbOrderRepository(name("order"));
  });

  beforeAll(async () => {
    orderUrl = await getOrderUrl();
  });
  beforeAll(() => captureCardPaymentTracker.clear());
  beforeAll(() => calculateTotalOrderTracker.clear());

  beforeAll(async () => {
    const orders = [
      { restaurantId: 1, total: 10 },
      { restaurantId: 2, total: 3 },
      { restaurantId: 2, total: 5 },
      { restaurantId: 5, total: 7 },
      { restaurantId: 5, total: 8 },
      { restaurantId: 6, total: 10 },
      { restaurantId: 6, total: 1 },
      { restaurantId: 6, total: 20 },
      { restaurantId: 9, total: 100 },
      { restaurantId: 9, total: 10 }
    ].map(({ restaurantId, total }) => createOrder(restaurantId, total));
    const orderUrl = await getOrderUrl();
    const responses = await Promise.all(
      orders.map(order => placeOrder(orderUrl, order))
    );
    const orderIds = responses.map(response => response.orderId);

    orderMap = orders.reduce((acc, order, i) => {
      acc[orderIds[i]] = order;
      return acc;
    }, {});
  });

  describe("happy path", () => {
    it("should store all placed orders in Order Table", async () => {
      Object.keys(orderMap).forEach(async orderId => {
        const savedOrder = await orderRepository.find(orderId);
        expect(savedOrder).toEqual(expect.objectContaining(orderMap[orderId]));
        expect(savedOrder.orderId).toEqual(orderId);
      });
    });

    it(
      "should capture all card payments",
      async () => {
        await invoke(name("process-card-payments")).fireAndForget();
        await captureCardPaymentTracker.waitUntil(10);
        const ticks = await captureCardPaymentTracker.getTicks();
        const capturedPaymentReferences = ticks
          .map(t => t.paymentReference)
          .sort();
        const paymentReferences = Object.values(orderMap)
          .map(order => order.paymentReference)
          .sort();

        expect(capturedPaymentReferences).toEqual(paymentReferences);
      },
      20000
    );

    it(
      "should calculate total order for every restaurants",
      async () => {
        await invoke(name("calculate-total-order")).fireAndForget();
        await calculateTotalOrderTracker.waitUntil(10);
        const ticks = await calculateTotalOrderTracker.getTicks();
        const actualTotalOrder = ticks.sort();

        const expectedTotalOrder = [
          { restaurantId: 1, total: 10 },
          { restaurantId: 2, total: 8 },
          { restaurantId: 3, total: 0 },
          { restaurantId: 4, total: 0 },
          { restaurantId: 5, total: 15 },
          { restaurantId: 6, total: 31 },
          { restaurantId: 7, total: 0 },
          { restaurantId: 8, total: 0 },
          { restaurantId: 9, total: 110 },
          { restaurantId: 10, total: 0 }
        ];

        expect(actualTotalOrder).toEqual(expectedTotalOrder);
      },
      20000
    );
  });

  describe("error scenario", () => {
    describe("place-order", () => {
      xit("should not place order when restaurantId is undefined", async () => {
        const order = createOrder(undefined, 10);
        await placeOrder(orderUrl, order);
      });
    });

    describe("capture-card-payment", () => {
      xit("should throw an error when paymentReference is not defined", async () => {
        const captureCardPayment = invoke(name("capture-card-payment"));
        await expect(captureCardPayment.requestResponse()).rejects.toThrow(
          "paymentReerence is required"
        );
      });
    });
  });
});
