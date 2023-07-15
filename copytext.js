// ==UserScript==
// @name         Copy Text Button
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Creates a button to copy text within <p> tags from the webpage.
// @author       Your Name
// @match        *://*/*
// @exclude      https://www.coursera.org/learn/*
// @exclude      https://platform.virdocs.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Create a button element
    var copyButton = document.createElement("button");
    copyButton.textContent = "Copy Text";
    copyButton.style.position = "fixed";
    copyButton.style.top = "0";
    copyButton.style.left = "0";
    copyButton.style.padding = "10px";
    copyButton.style.backgroundColor = "#4CAF50";
    copyButton.style.color = "white";
    copyButton.style.border = "none";
    copyButton.style.cursor = "pointer";
    copyButton.style.zIndex = "9999";

    // Find all <p> tags on the page
    var pElements = document.querySelectorAll('p');

    // Add an event listener to the button
    copyButton.addEventListener("click", function() {
        var copiedText = '';

        // Iterate over each <p> tag and append its text content
        for (var i = 0; i < pElements.length; i++) {
            copiedText += pElements[i].textContent.trim() + '\n';
        }

        // Create a temporary textarea element
        var tempTextarea = document.createElement("textarea");

        // Set the value of the temporary textarea to the copied text
        tempTextarea.value = copiedText;

        // Append the temporary textarea element to the body of the document
        document.body.appendChild(tempTextarea);

        // Select the contents of the temporary textarea
        tempTextarea.select();

        // Copy the selected text to the clipboard
        document.execCommand("copy");

        // Remove the temporary textarea element
        document.body.removeChild(tempTextarea);

        // Provide a visual feedback to the user
        alert("Text copied to clipboard!");
    });

    // Append the button to the body
    document.body.appendChild(copyButton);
})();
