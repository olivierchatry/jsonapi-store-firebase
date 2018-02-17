# jsonapi-store-firebase

`jsonapi-store-firebase` is a Firebase backed data store for [`jsonapi-server`](https://github.com/holidayextras/jsonapi-server).

This project conforms to the specification laid out in the [jsonapi-server handler documentation](https://github.com/holidayextras/jsonapi-server/blob/master/documentation/handlers.md).

### Usage

```javascript
var FirebaseStore = require("jsonapi-store-firebase");

jsonApi.define({
  resource: "comments",
  handlers: new FirebaseStore({
    serviceAccount:require("./serviceAccount.json")
    databaseName: "FIREBASE_DATABASE_NAME",
  })
});
```

### Features

 * Search, Find, Create, Delete, Update
Search is not very ligthly implemented ( just do an orderByKey, without any pagination or filtering ).
### Getting to Production

Getting this data store to production is really simple:

1. Deploy your code.
2. Celebrate.

When making schema changes, deploy away and carry on. If the changes aren't backwards compatible, you may want to run a job to ensure all old (existing) records conform to the new schema. If they don't conform to the new schema, they will be dropped by jsonapi-server's validation layer.

### Tests
Since firebase is closed source, it is not possible to have a valid set of test, unless someone create a firebase somewhere test system can hit. Will see later ( or maybe never, this project is to syphon data from different firebase to put them somewhere else )