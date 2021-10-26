import { SSM } from '@aws-sdk/client-ssm';

export async function getParameterValue(parameter_name: string): Promise<string> {
  const client = new SSM({ region: process.env.AWS_REGION });
  console.log('Calling out to SSM. If this times-out, check that any private subnets can connect to the public ' +
    'internet via NAT. https://aws.amazon.com/premiumsupport/knowledge-center/internet-access-lambda-function/');
  return (await client.getParameter({ Name: parameter_name, WithDecryption: true })).Parameter?.Value as string;
}
