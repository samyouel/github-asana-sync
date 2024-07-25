const core = require('@actions/core');
const action = require('./action');

// Mock the core.getInput function for local testing
// if (process.env.NODE_ENV !== 'production') {
//   core.getInput = (name) => {
//     const inputs = {
//       'action': 'add-asana-commit-comment',
//       'asana-pat': '<YOUR_ASANA_PERSONAL_ACCESS_TOKEN>',
//       'trigger-phrase': '',
//       'is-pinned': 'true',
//       'asana-tag-id': '45103304143385',
//       'asana-section-id': '1205811229322405',
//       'asana-project-id': '1205811229322400',
//     };
//     return inputs[name];
//   };
// }

async function run() {
  try {
    await action.action();
  } catch (error) {
    core.setFailed(error.message);
  }
}

run()