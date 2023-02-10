import dateFormat from 'dateformat';
import axios from 'axios';
import crypto from 'crypto';
import { ApolloServer, gql, ApolloError } from 'apollo-server';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { mapSchema, getDirective, MapperKind } from '@graphql-tools/utils';
import { defaultFieldResolver, GraphQLObjectType, GraphQLNonNull, GraphQLInt, GraphQLString } from 'graphql';

const typeDefs = gql`
  directive @uuid(field: String!) on OBJECT
  directive @upper on FIELD_DEFINITION
  directive @rest(url: String!) on FIELD_DEFINITION
  directive @rest2(url: String!) on FIELD_DEFINITION
  directive @auth(role: String!) on FIELD_DEFINITION
  directive @length(min: Int, max: Int) on FIELD_DEFINITION
  # Set a default format if not provided
  directive @date(format: String = "mm/dd/yyyy") on FIELD_DEFINITION
  
  type Query {
    post: Post 
    @auth(role: "ADMIN") 
    # @rest2(url: "https://jsonplaceholder.typicode.com/posts/2")
    @rest(url: "https://jsonplaceholder.typicode.com/posts/1")
  }

  type Post @uuid(field: "uuid") {
    id: Int!
    # uuid: ID!
    userId: Int!
    title: String! @upper # @rest(url: "https://jsonplaceholder.typicode.com/users/10")
    body: String! @length(min: 10)
    # modifiedAt: String! @date(format: "dddd, mmmm d, yyyy")
    createdAt: String! @date(format: "isoDateTime")
    uuid: ID!
  }

  # For injecting a new field into an object inside the input object
  directive @addField(name: String!, value: Int!) on FIELD_DEFINITION

  type Mutation {
    updateUser(input: UpdateUserInput!): User! @addField(name: "age", value: 101)
  }

  input UpdateUserInput {
    id: ID!
    name: String!
    email: String!
  }

  type User {
    id: ID!
    name: String!
    email: String!
    age: Int
    createdAt: String! @date(format: "isoDateTime")
  }
`;

const resolvers = {
  Query: {
    async post(_, args) {
      console.log((`🔴 in resolving post`));
      console.log(`🔴 args.post:${JSON.stringify(args.post)} \n---`);
      return args.post; // Injected into `args` by the `@rest` directive
    }
  },
  Mutation: {
    updateUser: (_, { input }, { dataSources }) => {
      console.log((`🟥 in resolving mutation user`));
      console.log(`🟥 input: ${JSON.stringify(input)}`);

      input.age += 1;
      return input;
    },
  },
};

let schema = makeExecutableSchema({
  typeDefs,
  resolvers
});

// Transform the schema by applying directive logic

// ORDER does matter
// schema = authDirectiveTransformer(schema, 'auth');
schema = restDirectiveTransformer(schema, 'rest2');
schema = restDirectiveTransformer(schema, 'rest');
schema = authDirectiveTransformer(schema, 'auth');

schema = upperDirectiveTransformer(schema, 'upper');
schema = lengthDirectiveTransformer(schema, 'length');
schema = uuidDirectiveTransformer(schema, 'uuid');
schema = dateDirectiveTransformer(schema, 'date');

schema = addFieldDirectiveTransformer(schema, 'addField');

// Start the server
const server = new ApolloServer({ schema });

server.listen().then(({ url }) => {
  console.log(`🚀 Server ready at ${url}`);
});

// 1 - upperDirectiveTransformer
function upperDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      // `OBJECT_FIELD` is the mapperkind while `FIELD_DEFINITION` is location name in schema
      // Check whether this field has the specified directive
      const upperDirective = getDirective(schema, fieldConfig, directiveName)?.[0];

      if (upperDirective) {
        // Get this field's original resolver
        // If the original resolver is not given, then a default resolve behavior is used
        const { resolve = defaultFieldResolver } = fieldConfig;

        // Replace the original resolver with a function that *first* calls
        // the original resolver, then converts its result to upper case
        fieldConfig.resolve = async function (source, args, context, info) {
          console.log(`🟢 1. in UPPER`);
          const result = await resolve(source, args, context, info); // Calling the original resolver
          if (typeof result === 'string') return result.toUpperCase(); // Uppercasing the result

          return result;
        };

        return fieldConfig;
      }

    }
  });
}

// 2 - date
function dateDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      const dateDirective = getDirective(schema, fieldConfig, directiveName)?.[0];
      if (dateDirective) {
        const { resolve = defaultFieldResolver } = fieldConfig;
        const { format } = dateDirective; // Get the directive param

        fieldConfig.resolve = async function (source, args, context, info) {
          console.log(`🟡 2. in DATE`);
          const result = await resolve(source, args, context, info);

          try {
            if (!result) return dateFormat(new Date(), format);
            return dateFormat(result, format);
          } catch {
            throw new ApolloError('Invalid Format!');
          }
        };
        return fieldConfig;
      }
    }
  });
}

// 3 - REST
function restDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      const restDirective = getDirective(schema, fieldConfig, directiveName)?.[0];

      if (restDirective) {
        const { url } = restDirective; // Get the param
        const { resolve = defaultFieldResolver } = fieldConfig;

        fieldConfig.resolve = async function (source, args, context, info) {
          console.log(`🟠 3. in REST, url: ${url}`);

          if (args.post) console.log(`🟠  args.post.id: ${args.post.id}`)

          let { data } = await axios.get(url); // Use axios to get the post from a third-party
          console.log(`🟠 data.id: ${data.id} \n ------`)

          // Inject the post in `args` to be able to return it from resolver
          return await resolve(source, { ...args, post: data }, context, info);
        };
        return fieldConfig;
      }
    }
  });

}

// 4 - Auth ??
function authDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      const authDirective = getDirective(schema, fieldConfig, directiveName)?.[0];
      if (authDirective) {
        const { resolve = defaultFieldResolver } = fieldConfig;
        const { role } = authDirective; // Get the directive param

        fieldConfig.resolve = async function (source, args, context, info) {
          console.log(`🔵 4. in AUTH`);
          //console.log(`🔵 AUTH.context ${JSON.stringify(context)} \n`);

          // Check the authorization before calling the resolver itself
          if (role !== 'ADMIN') throw new ApolloError('Unauthorized!');
          return await resolve(source, args, context, info);
        };
        return fieldConfig;
      }
    }
  });
}

// 5 - UUID
function uuidDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    // The mapper for OBJECT is OBJECT_TYPE
    [MapperKind.OBJECT_TYPE]: (type) => {
      const uuidDirective = getDirective(schema, type, directiveName)?.[0];
      if (uuidDirective) {
        // find the "uuid" fieldConfig in the `Post` object and set the resolver

        const { field } = uuidDirective; // Get the directive param
        const config = type.toConfig();

        // console.log(`5. in UUID config: ${JSON.stringify(config.fields[field], null, 1)}`);
        config.fields[field].resolve = () => {
          console.log(`🟣 5. in UUID field: ${JSON.stringify(field)}\n`);
          return crypto.randomUUID();
        }
        return new GraphQLObjectType(config);
      }
    }
  });
}

// 6 - length
function lengthDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      const lengthDirective = getDirective(schema, fieldConfig, directiveName)?.[0];
      if (lengthDirective) {
        const { resolve = defaultFieldResolver } = fieldConfig;
        const { min, max } = lengthDirective;

        fieldConfig.resolve = async function (source, args, context, info) {
          console.log(`🟤 6. in LENGTH`);

          const result = await resolve(source, args, context, info);
          if (min !== undefined && typeof result === 'string' && result.length < min) {
            throw new ApolloError(
              `The field ${fieldConfig.astNode.name.value} should contain at least ${min} characters`
            );
          }
          if (max !== undefined && typeof result === 'string' && result.length > max) {
            throw new ApolloError(
              `The field ${fieldConfig.astNode.name.value} shouldn't exceed the max length (${max})`
            );
          }
          return result;
        };
        return fieldConfig;
      }
    }
  });
}

// 7 - addField
function addFieldDirectiveTransformer(schema, directiveName) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
      const myDirective = getDirective(schema, fieldConfig, directiveName)?.[0];

      if (myDirective) {
        const { name, value } = myDirective;
        const { resolve = defaultFieldResolver } = fieldConfig;

        fieldConfig.resolve = async function (parent, input, context, ...rest) {
          console.log(`🟧 7. in ADD_FIELD`);
          console.log(`🟧 input:${JSON.stringify(input)}`);

          // injecting
          input.input[name] = value;

          const result = await resolve(parent, input, context, ...rest); // Calling the original resolver
          return result;
        };
      }

      return fieldConfig;
    }
  });

}
