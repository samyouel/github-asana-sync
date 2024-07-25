const core = require('@actions/core');
const github = require('@actions/github');
const octokit = require('@octokit/core');
const asana = require('asana');

// // Mock the core.getInput function for local testing
// const fs = require('fs');

// // Read the JSON file
// const rawData = fs.readFileSync('./github-commit-context.json');
// const github = JSON.parse(rawData);

function buildAsanaClient() {
    const ASANA_PAT = core.getInput('asana-pat');
    return asana.Client.create({
        defaultHeaders: { 'asana-enable': 'new-sections,string_ids' },
        logAsanaChangeWarnings: false
    }).useAccessToken(ASANA_PAT).authorize();
}

function buildGithubClient(githubPAT) {
    return new octokit.Octokit({
        auth: githubPAT
    })
}

function findAsanaTasks(search_string) {
    const
        TRIGGER_PHRASE = core.getInput('trigger-phrase'),
        SEARCH_STRING = search_string,
        REGEX_STRING = `${TRIGGER_PHRASE}https:\\/\\/app.asana.com\\/(\\d+)\\/(?<projectId>\\d+)\\/(?<taskId>\\d+).*?`,
        REGEX = new RegExp(REGEX_STRING, 'g');

    console.info('looking for asana task link in this string:', SEARCH_STRING, ' regex:', REGEX_STRING);
    let foundTasks = [];
    while ((parseAsanaUrl = REGEX.exec(SEARCH_STRING)) !== null) {
        const task = parseAsanaUrl.groups;
        if (!task) {
            core.error(`Invalid Asana task URL after trigger-phrase ${TRIGGER_PHRASE}`);
            continue;
        }
        foundTasks.push(task);
    }
    console.info(`found ${foundTasks.length} tasksIds:`, foundTasks.map(item => item.taskId).join(','));
    return foundTasks
}

function commitComment(commit) {
    const
        COMMIT_MESSAGE = commit.message,
        COMMIT_AUTHOR = commit.committer.name,
        COMMIT_URL = commit.url,
        COMMIT_SHA = commit.id.substring(0, 7),
        COMMIT_MESSAGE_HEADER = commitMessageHeader(COMMIT_MESSAGE);

    return `<body><code><a href="${COMMIT_URL}">${COMMIT_SHA}</a></code> ${COMMIT_MESSAGE_HEADER} [${COMMIT_AUTHOR}]</body>`;
}

function commitMessageHeader(str) {
    const index = str.indexOf('\n');
    return index !== -1 ? str.substring(0, index) : str;
}

async function createStory(client, taskId, text, isPinned) {
    try {
        return await client.stories.createStoryForTask(taskId, {
            html_text: text,
            is_pinned: isPinned,
        });
    } catch (error) {
        console.error('rejecting promise', error);
    }
}

async function createTaskWithComment(client, name, description, comment, projectId) {
    try {
        client.tasks.createTask({
            name: name,
            notes: description,
            projects: [projectId],
            pretty: true
        })
            .then((result) => {
                console.log('task created', result.gid);
                return createStory(client, result.gid, comment, true)
            })
    } catch (error) {
        console.error('rejecting promise', error);
    }
}

async function createIssueTask() {
    const client = await buildAsanaClient();
    const ISSUE = github.context.payload.issue;
    const ASANA_PROJECT_ID = core.getInput('asana-project', { required: true });

    console.info('creating asana task from issue', ISSUE.title);

    const TASK_DESCRIPTION = `Description: ${ISSUE.body}`;
    const TASK_NAME = `Github Issue: ${ISSUE.title}`;
    const TASK_COMMENT = `Link to Issue: ${ISSUE.html_url}`;

    return createTaskWithComment(client, TASK_NAME, TASK_DESCRIPTION, TASK_COMMENT, ASANA_PROJECT_ID)
}


async function notifyPRApproved() {
    const client = await buildAsanaClient();
    const
        PULL_REQUEST = github.context.payload.pull_request,
        TASK_COMMENT = `PR: ${PULL_REQUEST.html_url} has been approved`;

    const foundTasks = findAsanaTasks(PULL_REQUEST.body)

    const comments = [];
    for (const task of foundTasks) {
        const comment = createStory(client, task.taskId, TASK_COMMENT, false)
        comments.push(comment)
    }
    return comments;
}

async function addTaskToAsanaProject() {
    const client = await buildAsanaClient();

    const projectId = core.getInput('asana-project', { required: true });
    const sectionId = core.getInput('asana-section');
    const taskId = core.getInput('asana-task-id', { required: true });

    addTaskToProject(client, taskId, projectId, sectionId)
}

async function addTaskToProject(client, taskId, projectId, sectionId) {
    if (!sectionId) {
        console.info('adding asana task to project', projectId);
        try {
            return await client.tasks.addProjectForTask(taskId, {
                project: projectId,
                insert_after: null
            });
        } catch (error) {
            console.error('rejecting promise', error);
        }
    } else {
        console.info(`adding asana task to top of section ${sectionId} in project ${projectId}`);
        try {
            return await client.tasks.addProjectForTask(taskId, {
                project: projectId
            })
                .then((result) => {
                    client.sections.addTaskForSection(sectionId, { task: taskId })
                        .then((result) => {
                            console.log(result);
                        });
                });
        } catch (error) {
            console.error('rejecting promise', error);
        }
    }
}

async function addCommentToPrTask() {
    const
        PULL_REQUEST = github.context.payload.pull_request,
        TASK_COMMENT = `PR: ${PULL_REQUEST.html_url}`,
        isPinned = core.getInput('is-pinned') === 'true';

    let commentText = core.getInput('comment-text');

    if (commentText) {
        console.info('using custom comment text', commentText);
        commentText = `<body>${commentText}</body>`;
    }

    const client = await buildAsanaClient();

    const foundTasks = findAsanaTasks(PULL_REQUEST.body)

    const comments = [];
    for (const task of foundTasks) {
        const comment = createStory(client, task.taskId, commentText || TASK_COMMENT, isPinned)
        comments.push(comment)
    }
    return comments;
}

async function addCommitCommentToTasks() {
    const COMMITS = github.context.payload.commits,
        isPinned = core.getInput('is-pinned') === 'true';
    let commentText = core.getInput('comment-text');

    if (commentText) {
        console.info('using custom comment text', commentText);
        commentText = `<body>${commentText}</body>`;
    }

    const client = await buildAsanaClient();

    for (const commit of COMMITS) {
        const foundTasks = findAsanaTasks(commit.message),
        TASK_COMMENT = commentText || commitComment(commit);

        const comments = [];
        for (const task of foundTasks) {
            const comment = createStory(client, task.taskId, TASK_COMMENT, isPinned);
            comments.push(comment);
        }
        await Promise.all(comments);
        return comments;
    }
}

async function createPullRequestTask() {
    const client = await buildAsanaClient();
    const PULL_REQUEST = github.context.payload.pull_request;
    const ASANA_PROJECT_ID = core.getInput('asana-project', { required: true });

    console.info('creating asana task from pull request', PULL_REQUEST.title);

    const TASK_DESCRIPTION = `Description: ${PULL_REQUEST.body}`;
    const TASK_NAME = `Community Pull Request: ${PULL_REQUEST.title}`;
    const TASK_COMMENT = `Link to Pull Request: ${PULL_REQUEST.html_url}`;

    return createTaskWithComment(client, TASK_NAME, TASK_DESCRIPTION, TASK_COMMENT, ASANA_PROJECT_ID)
}

async function completePRTask() {
    const client = await buildAsanaClient(),
        isComplete = core.getInput('is-complete') === 'true',
        PULL_REQUEST = github.context.payload.pull_request;

    const foundTasks = findAsanaTasks(PULL_REQUEST.body)

    const taskIds = [];
    for (const task of foundTasks) {
        console.info("marking task", task.taskId, isComplete ? 'complete' : 'incomplete');
        try {
            await client.tasks.update(taskId, {
                completed: isComplete
            });
        } catch (error) {
            console.error('rejecting promise', error);
        }
        taskIds.push(taskId);
    }
    return taskIds;
}

async function checkPRMembership() {
    const
        PULL_REQUEST = github.context.payload.pull_request,
        ORG = PULL_REQUEST.base.repo.owner.login,
        USER = PULL_REQUEST.user.login;
    HEAD = PULL_REQUEST.head.user.login

    console.info(`PR opened/reopened by ${USER}, checking membership in ${ORG}`);
    if (HEAD === ORG) {
        console.log(author, `belongs to duckduckgo}`)
        core.setOutput('external', false)
    } else {
        console.log(author, `does not belong to duckduckgo}`)
        core.setOutput('external', true)
    }
}

async function getLatestRepositoryRelease() {
    const
        GITHUB_PAT = core.getInput('github-pat', { required: true }),
        githubClient = buildGithubClient(GITHUB_PAT),
        ORG = core.getInput('github-org', { required: true }),
        REPO = core.getInput('github-repository', { required: true });

    try {
        await githubClient.request('GET /repos/{owner}/{repo}/releases/latest', {
            owner: ORG,
            repo: REPO,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        }).then((response) => {
            const version = response.data.tag_name
            console.log(REPO, `latest version is ${version}`)
            core.setOutput('version', version)
        });
    } catch (error) {
        console.log(REPO, `can't find latest version ${error}`)
        core.setFailed(`can't find latest version for ${REPO}`);
    }

}

async function findTaskInSection(client, sectionId, name) {
    let existingTaskId = "0"
    try {
        console.log('searching tasks in section', sectionId);
        await client.tasks.getTasksForSection(sectionId).then((result) => {
            const task = result.data.find(task => task.name === name);
            if (!task) {
                console.log("task not found")
                existingTaskId = "0"
            } else {
                console.info('task found', task.gid);
                existingTaskId = task.gid
            }
        });
    } catch (error) {
        console.error('rejecting promise', error);
    }
    return existingTaskId
}

async function createTask(client, name, description, projectId) {
    console.log('creating new task', name);
    let createdTaskId = "0"
    try {
        await client.tasks.createTask({
            name: name,
            notes: description,
            projects: [projectId],
            pretty: true
        })
            .then((result) => {
                createdTaskId = result.gid
                console.log('task created', createdTaskId);
            })
    } catch (error) {
        console.error('rejecting promise', error);
    }
    return createdTaskId
}

async function createTaskInSection(client, name, description, projectId, sectionId) {
    console.log('creating new task in section', sectionId);
    let createdTaskId = "0"
    try {
        await client.tasks.createTask({
            name: name,
            notes: description,
            projects: [projectId],
            memberships: [{ project: projectId, section: sectionId }],
            pretty: true
        })
            .then((result) => {
                createdTaskId = result.gid
                console.log('task created in section', createdTaskId);
                core.setOutput('taskId', createdTaskId)
                core.setOutput('duplicate', false)
            })
    } catch (error) {
        console.error('rejecting promise', error);
    }
    return createdTaskId
}

async function createTaskIfNotDuplicate(client, name, description, projectId, sectionId) {
    console.log('checking for duplicate task before creating a new one', name);
    let existingTaskId = await findTaskInSection(client, sectionId, name)
    if (existingTaskId == "0") {
        return createTaskInSection(client, name, description, projectId, sectionId)
    } else {
        console.log("task already exists, skipping")
        core.setOutput('taskId', existingTaskId)
        core.setOutput('duplicate', true)
    }
    return existingTaskId
}

async function createAsanaTask() {
    const client = await buildAsanaClient();

    const
        projectId = core.getInput('asana-project', { required: true }),
        sectionId = core.getInput('asana-section'),
        taskName = core.getInput('asana-task-name', { required: true }),
        taskDescription = core.getInput('asana-task-description', { required: true });

    if (sectionId === "") {
        return createTask(client, taskName, taskDescription, projectId)
    } else {
        return createTaskIfNotDuplicate(client, taskName, taskDescription, projectId, sectionId)
    }
}

async function addTaskPRDescription() {
    const
        GITHUB_PAT = core.getInput('github-pat'),
        githubClient = buildGithubClient(GITHUB_PAT),
        ORG = core.getInput('github-org', { required: true }),
        REPO = core.getInput('github-repository', { required: true }),
        PR = core.getInput('github-pr', { required: true }),
        projectId = core.getInput('asana-project', { required: true }),
        taskId = core.getInput('asana-task-id', { required: true });

    githubClient.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: ORG,
        repo: REPO,
        pull_number: PR,
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    }).then((response) => {
        console.log(response.data.body);
        const body = response.data.body;
        const asanaTaskMessage = `Task/Issue URL: https://app.asana.com/0/${projectId}/${taskId}/f`;
        const updatedBody = `${asanaTaskMessage} \n\n ----- \n${body}`;

        githubClient.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: ORG,
            repo: REPO,
            pull_number: PR,
            body: updatedBody,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        })
            .catch((error) => core.error(error));

    });

}

async function addTagAsana(taskId, tagId) {
    const client = await buildAsanaClient();
    try {
        return await client.tasks.addTagForTask(taskId, {
            tag: tagId
        });
    } catch (error) {
        console.error('rejecting promise', error);
    };
}

async function removeTagAsana(taskId, tagId) {
    const client = await buildAsanaClient();
    try {
        return await client.tasks.removeTagForTask(taskId, {
            tag: tagId
        });
    } catch (error) {
        console.error('rejecting promise', error);
    };
}

async function moveTaskAsana(taskId, sectionId) {
    const client = await buildAsanaClient();
    try {
        return await client.sections.addTaskForSection(sectionId, {
            task: taskId
        });
    } catch (error) {
        console.error('rejecting promise', error);
    };
}

async function addTagToTask() {
    const tagId = core.getInput('asana-tag-id', { required: true });

    if (pull_request = github.context.payload?.pull_request) {
        const foundTasks = findAsanaTasks(pull_request.body);
        for (const task of foundTasks) {
            addTagAsana(task.taskId, tagId);
        }
    } else {
        for (const commit of github.context.payload?.commits) {
            const foundTasks = findAsanaTasks(commit.message);
            for (const task of foundTasks) {
                addTagAsana(task.taskId, tagId);
            }
        }
    }
    return tagId;
}

async function removeTagFromTask() {
    const tagId = core.getInput('asana-tag-id', { required: true });

    if (pull_request = github.context.payload?.pull_request) {
        const foundTasks = findAsanaTasks(pull_request.body);
        for (const task of foundTasks) {
            removeTagAsana(task.taskId, tagId);
            console.log('removing tag', tagId, 'from task', task.taskId);
        }
    } else {
        for (const commit of github.context.payload?.commits) {
            const foundTasks = findAsanaTasks(commit.message);
            for (const task of foundTasks) {
                removeTagAsana(task.taskId, tagId);
                console.log('removing tag', tagId, 'from task', task.taskId);
            }
        }
    }
    return tagId;
}

async function moveTaskToSection() {
    const sectionId = core.getInput('asana-section-id', { required: true }),
          projectId = core.getInput('asana-project-id', { required: true });

    if (pull_request = github.context.payload?.pull_request) {
        const foundTasks = findAsanaTasks(pull_request.body);
        for (const task of foundTasks) {
            if (task.projectId == projectId) {
                moveTaskAsana(task.taskId, sectionId);
                console.log('moving task', task.taskId, 'to section', sectionId);
            } else {
                console.log('task not in project', projectId);
            }
        }
    } else {
        for (const commit of github.context.payload?.commits) {
            const foundTasks = findAsanaTasks(commit.message);
            for (const task of foundTasks) {
                if (task.projectId == projectId) {
                    moveTaskAsana(task.taskId, sectionId);
                    console.log('moving task', task.taskId, 'to section', sectionId);
                } else {
                    console.log('task not in project', projectId);
                }
            }
        }
    }
    return sectionId;
}

async function action() {
    const ACTION = core.getInput('action', { required: true });
    console.info('calling', ACTION);

    switch (ACTION) {
        case 'create-asana-issue-task': {
            createIssueTask();
            break;
        }
        case 'notify-pr-approved': {
            notifyPRApproved();
            break;
        }
        case 'notify-pr-merged': {
            completePRTask()
            break;
        }
        case 'check-pr-membership': {
            checkPRMembership();
            break;
        }
        case 'add-asana-commit-comment': {
            addCommitCommentToTasks();
            break;
        }
        case 'add-asana-pr-comment': {
            addCommentToPrTask();
            break;
        }
        case 'add-task-asana-project': {
            addTaskToAsanaProject();
            break;
        }
        case 'create-asana-pr-task': {
            createPullRequestTask();
            break;
        }
        case 'get-latest-repo-release': {
            getLatestRepositoryRelease();
            break;
        }
        case 'create-asana-task': {
            createAsanaTask();
            break;
        }
        case 'add-task-pr-description': {
            addTaskPRDescription();
            break;
        }
        case 'add-tag-to-task': {
            addTagToTask();
            break;
        }
        case 'remove-tag-from-task': {
            removeTagFromTask();
            break;
        }
        case 'move-task-to-section': {
            moveTaskToSection();
            break;
        }
        default:
            core.setFailed(`unexpected action ${ACTION}`);
    }
}

module.exports = {
    action,
    default: action,
};