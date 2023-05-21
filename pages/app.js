import React, { useEffect, useRef, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";

import Header from "../containers/Header";
import ChatBot from "../containers/ChatBot";
import CodeExplorer from "../containers/CodeExplorer";
import Spinner from "../components/Spinner";
import SubscriptionModal from "../containers/SubscriptionModal";

import Mixpanel from "../library/mixpanel";
import { Source, Message } from "../library/data";
import { useRouter } from "next/router";

const WELCOME_MESSAGE = "I'm here to help you understand your codebase. Get started by importing a GitHub repository or a code snippet. You can ask me to explain how something works, where something is implemented, or even how to debug an error."

export default function App() {
    const { isAuthenticated, getAccessTokenSilently, user, isLoading } = useAuth0();
    const [codebaseId, setCodebaseId] = useState("");
    const [messages, setMessages] = useState([new Message(WELCOME_MESSAGE, true, true)]);
    const [subscriptionStatus, setSubscriptionStatus] = useState({});
    const [renderSubscriptionModal, setRenderSubscriptionModal] = useState(false);
    const [fileContext, setFileContext] = useState("");
    const queryWS = useRef(null);
    const prevAuthState = useRef(isAuthenticated);
    const router = useRouter();

    function handleOAuthCallback() {
        const { source, code } = router.query;

        if (!source) {
            return;
        }

        getAccessTokenSilently()
            .then(token => {
                fetch(`${process.env.NEXT_PUBLIC_API_URI}api/${source}_callback`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${token}`
                    },
                    body: JSON.stringify({ user_id: user.sub, code })
                })
                    .then(res => res.json())
                    .then(data => {
                        // TODO: Update state to tell CodeExplorer to render the SelectRepository view
                    })
            });
    }

    function fetchUserMetadata() {
        /* Fetch user's subscription status */

        getAccessTokenSilently()
            .then(token => {
                fetch(`${process.env.NEXT_PUBLIC_API_URI}api/stripe/subscription_status`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        user_id: user.sub,
                        email: user.email
                    })
                })
                    .then(res => res.json())
                    .then(data => {
                        const {
                            plan,
                            num_messages_sent,
                            num_repositories_indexed,
                            num_code_snippets_indexed
                        } = data;

                        setSubscriptionStatus({
                            plan,
                            numMessagesSent: num_messages_sent,
                            numRepositoriesIndexed: num_repositories_indexed,
                            numCodeSnippetsIndexed: num_code_snippets_indexed
                        });
                    });
            });
    }

    function setShowSubscriptionModal(isVisible) {
        setRenderSubscriptionModal(isVisible);
    }

    function getChatHistory() {
        return messages
            .slice(1)
            .map(message => {
                return {
                    content: message.content,
                    is_response: message.isResponse
            };
            })
            .filter((message, index) => index < messages.length - 3);
    }

    function onSubmitQuery(message, regenerate = false) {
        const query = new Message(message, false, true);
        let response = new Message("", true, false);

        if (!isAuthenticated) { // TODO: Display blurred output and prompt user to sign up
            response.content = "You must be signed in to use the chatbot.";
            response.isComplete = true;
        }

        setMessages(prevMessages => {
            if (regenerate) {
                let priorMessages = prevMessages.slice(0, prevMessages.length - 1);
                return [...priorMessages, response];
            }

            let priorMessages = prevMessages.slice(0, prevMessages.length);
            return [...priorMessages, query, response];
        });
        // localStorage.setItem(codebaseId, JSON.stringify(priorMessages));

        getAccessTokenSilently()
            .then(token => {
                const request = {
                    user_id: user.sub,
                    token: token,
                    codebase_id: codebaseId,
                    query: message,
                    chat_history: getChatHistory()
                };
                queryWS.current.send(JSON.stringify(request));
                Mixpanel.track("received_chatbot_response", { query: message });
            });
    }

    function onSetCodebaseId(codebaseId) {
        setCodebaseId(codebaseId);
        // setMessages(JSON.parse(localStorage.getItem(codebaseId)) || [new Message(WELCOME_MESSAGE, true, true)]);
    }

    function onClearConversation() {
        setMessages([new Message(WELCOME_MESSAGE, true, true)]);
    }

    /* Helpers */

    function renderApp() {
        return (
            <div className="app">
                <Header setShowSubscriptionModal={setShowSubscriptionModal} />

                {
                    isLoading ?
                        <div id="loadingBody">
                            <Spinner />
                        </div>
                        :
                        <div className="body">
                            <ChatBot
                                messages={messages}
                                onSubmitQuery={onSubmitQuery}
                                onUpgradePlan={() => setShowSubscriptionModal(true)}
                                setFileContext={setFileContext}
                                onClearConversation={onClearConversation}
                            />
                            <CodeExplorer
                                onSetCodebaseId={onSetCodebaseId}
                                codebaseId={codebaseId}
                                onUpgradePlan={() => setShowSubscriptionModal(true)}
                                setFileContext={setFileContext}
                                fileContext={fileContext}
                            />
                        </div>
                }
            </div>
        )
    }

    /* Lifecycle Methods */

    useEffect(() => {
        if (isAuthenticated) {
            Mixpanel.identify(user.sub);
            Mixpanel.people.set({ email: user.email });
        }

        Mixpanel.track("load_playground");

        // TODO: Only connect to websocket when user is authenticated (will reduce load on server)

        /* Connect to query handler websocket */

        let ws = new WebSocket(`${process.env.NEXT_PUBLIC_WEBSOCKET_URI}answer_query`);

        ws.onopen = event => {
        }; // QUESTION: Should we wait to render the rest of the site until connection is established?
        ws.onmessage = event => {
            const {
                type,
                data,
                is_finished,
                is_paywalled,
                progress_target,
                error
            } = JSON.parse(event.data);

            console.log(event.data);

            if (type === "loading") {
                const { step, message } = data;

                setMessages(prevMessages => {
                    const priorMessages = prevMessages.slice(0, prevMessages.length - 1);
                    let lastMessage = prevMessages[prevMessages.length - 1];

                    if (lastMessage.loadingSteps.length === 0) { // First loading step
                        lastMessage.loadingSteps.push(data);
                    } else {
                        const lastLoadingStep = lastMessage.loadingSteps[lastMessage.loadingSteps.length - 1];
                        if (lastLoadingStep.step === step) { // Same loading step
                            lastLoadingStep.message += message;
                            lastMessage.loadingSteps[lastMessage.loadingSteps.length - 1] = lastLoadingStep;
                        } else if (step.toLowerCase() == "progress") { // Progress update
                            lastMessage.progress += 1;
                            lastMessage.progressTarget = progress_target;
                        } else { // New loading step
                            lastMessage.loadingSteps.push(data);
                        }
                    }

                    return [...priorMessages, lastMessage];
                });
            } else if (type == "answer") {
                const { message, sources } = data;

                setMessages(prevMessages => {
                    const priorMessages = prevMessages.slice(0, prevMessages.length - 1);
                    let response = prevMessages[prevMessages.length - 1];

                    response.content += message;
                    response.isComplete = is_finished;
                    response.isPaywalled = is_paywalled;
                    response.sources = sources.map(filePath => new Source(filePath));
                    response.progressTarget = null;

                    return [...priorMessages, response];
                });
            }
        }
        ws.onerror = event => {
            console.log(event); // TODO: Display error message
        };
        queryWS.current = ws;

        if (isAuthenticated) {
            fetchUserMetadata();
            handleOAuthCallback();
        }
    }, [])

    useEffect(() => {
        if (isAuthenticated) {
            handleOAuthCallback();
        }
    }, [router.isReady])

    useEffect(() => {
        if (prevAuthState.current !== isAuthenticated && isAuthenticated) {
            handleOAuthCallback();
            fetchUserMetadata();
        }

        prevAuthState.current = isAuthenticated;
    }, [isAuthenticated])

    return (
        <>
            {renderApp()}
            {renderSubscriptionModal ?
                <div className={"grid p-2 justify-items-center"}>
                    <SubscriptionModal setShowSubscriptionModal={setShowSubscriptionModal} />
                </div>
                : null
            }
        </>
    );

}