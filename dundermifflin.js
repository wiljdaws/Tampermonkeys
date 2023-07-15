// ==UserScript==
// @name         Dunder Mifflin
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Replaces images with The Office Memes
// @author       wiljdaws 
// @match        http://*/*
// @match        https://*/*
// @grant        GM_addStyle
// @icon         https://ih1.redbubble.net/image.254543120.1040/flat,800x800,075,f.u1.jpg
// @require      https://code.jquery.com/jquery-3.7.0.min.js
// ==/UserScript==

(function() {
    'use strict';

    // Array of funny office meme image URLs to be used as replacements
    var officeMemes = [
        {
            url: 'https://media.giphy.com/media/kxPj5ssj9BW4o/giphy.gif',
            duration: 10000, // 5 seconds
            weight: 1 // Equal chance for all memes
        },
        {
            url: 'https://media.giphy.com/media/eTjOuvwVTvxDO/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/xO61YRkUGOBws/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/jp7jSyjNNz2ansuOS8/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/cXblnKXr2BQOaYnTni/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/BY8ORoRpnJDXeBNwxg/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/tkApIfibjeWt1ufWwj/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/ynRrAHj5SWAu8RA002/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/BpGWitbFZflfSUYuZ9/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/DhstvI3zZ598Nb1rFf/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/MZocLC5dJprPTcrm65/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/hyyV7pnbE0FqLNBAzs/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/l0amJzVHIAfl7jMDos/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/VMO6qeIbr7JRLnLTGw/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/LXfpI3nNbfCm91llsA/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/JKCgYjL74Z3p4IutkI/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/UAHZijO91QCl2/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/eKDp7xvUdbCrC/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/4cuyucPeVWbNS/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/gQn5eZj03hxnlEIJw2/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/IjJ8FVe4HVk66yvlV2/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/4LsN0YwgIsvaU/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/2oUfvvUgQHnLsQWFMW/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/XoCI9HIAQEz1dSIvIy/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/s3d5ugcxFDApG/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/wranrCRq3f90A/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/PiZwqwp22mLjW/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/6zwCn1vbgaYZDVnQt2/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/niC0LL8nmXnWp0d7Sn/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/7AoJzTRD1WzOU/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/SSVkpVYj0Qgy4/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/woPJ4I9nDVvL7s3fMv/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/CxZBDpNYR7e22FDMhK/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/Cz1it5S65QGuA/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/5xtDarIX9MTLD1pMoXC/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/FIyOndr9jvel8vTHLH/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/YUH1nLsoiAOagDflxV/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/wsuqQBTFD5DAq0VPQO/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/XfYyQFiq9ySc0/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/INNAR5yC5U9gI/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/UVah1k9VydwNC4RdOT/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/122pLlowwMS5aM/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/3o7TKJ9WK7JRk9QVos/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/5HofEuEPYmhgFVrOHq/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/AfOBdq0rumImNlukVz/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/3gjrljXpYxdYK72U96/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/r9Z67vs8qny1Mf5hOg/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/xoV4JZ3cBaSGngdxxl/giphy.gif',
            duration: 10000,
            weight: 1
        },
        {
            url: 'https://media.giphy.com/media/ihBQKvIE7gLEA/giphy.gif',
            duration: 10000,
            weight: 1
        },
    ];

    // Merge the additional memes with the existing memes
   // officeMemes = officeMemes.concat(additionalMemes);

    function replaceImages() {
        $('img').each(function() {
            replaceWithRandomMeme(this);
        });

        $('video').each(function() {
            replaceWithRandomMeme(this);
        });

        $('iframe').each(function() {
            replaceWithRandomMeme(this);
        });
    }

    function replaceWithRandomMeme(element) {
        var randomIndex = Math.floor(Math.random() * officeMemes.length);
        var meme = officeMemes[randomIndex];

        $(element).attr('src', meme.url);

        setTimeout(function() {
            replaceWithDifferentMeme(element);
        }, meme.duration);
    }

    function replaceWithDifferentMeme(element) {
        var currentUrl = $(element).attr('src');
        var currentMeme = officeMemes.find(function(meme) {
            return currentUrl === meme.url;
        });

        var filteredMemes = officeMemes.filter(function(meme) {
            return meme !== currentMeme;
        });

        if (filteredMemes.length > 0) {
            var randomIndex = Math.floor(Math.random() * filteredMemes.length);
            var meme = filteredMemes[randomIndex];

            $(element).attr('src', meme.url);

            setTimeout(function() {
                replaceWithDifferentMeme(element);
            }, meme.duration);
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function prankLoop() {
        while (true) {
            replaceImages();
            await sleep(30000); // Sleep for 30 seconds
        }
    }

    // Call the prankLoop function when the page finishes loading
    $(window).on('load', prankLoop);
})();
