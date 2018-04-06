
  // fill local usercrypto object with keys and nonce later on
  GL = {
    usercrypto:{ user_keys: args.user_keys, nonce: args.nonce },
    powqueue:[],
    coinMarketCapTickers: []
  };

  // retrieve modes supported by node
  GL.cur_step = nextStep();
  $.ajax({ url: path+zchan(GL.usercrypto,GL.cur_step,'l/asset/modes'),
    success: function(object){
      object = zchan_obj(GL.usercrypto,GL.cur_step,object);
      GL.assetmodes=object.data;
      // retrieve names supported by node
      GL.cur_step = nextStep();
      $.ajax({ url: path+zchan(GL.usercrypto,GL.cur_step,'l/asset/names'),
        success: function(object){
          object = zchan_obj(GL.usercrypto,GL.cur_step,object);
          GL.assetnames=object.data;

          getDollarPrices(function () {
            console.log('Fetched prices');
          });
          // Switch to dashboard view
          fetchview('interface.dashboard',args);
        }
      });
    }
  });

  // once every two minutes, loop through proof-of-work queue
  intervals.pow = setInterval(function() {
    var req = GL.powqueue.shift();
    if(typeof req !== 'undefined') {
      // attempt to send proof-of-work to node
      proofOfWork.solve(req.split('/')[1],
        function(proof){
          // DEBUG:
          logger('submitting storage proof: '+req.split('/')[0]+'/'+proof);
          hybriddcall({r:'s/storage/pow/'+req.split('/')[0]+'/'+proof,z:0},0, function(object) {});
        },
        function(){
          // DEBUG:
          logger('failed storage proof: '+req.split('/')[0]);
        }
      );
    }
  },120000);

getDollarPrices = function (cb) {
  $.ajax({
    url: 'https://api.coinmarketcap.com/v1/ticker/?limit=0',
    dataType: 'json'
  })
    .done(function (data) {
      GL.coinMarketCapTickers = data;
      cb();
    })
    .error(function (e) {
    });
};

renderDollarPrice = function (symbolName, assetAmount) {
  var assetSymbolUpperCase = symbolName.toUpperCase();
  var tickers = GL.coinMarketCapTickers;
  var matchedTicker = tickers.filter(function (ticker) {
    return ticker.symbol === assetSymbolUpperCase;
  });

  return matchedTicker.length !== 0
    ? '$' + (assetAmount * matchedTicker[0].price_usd).toFixed(2)
    : 'n/a';
};

mkSvgIcon = function (symbolName) {
  var firstLetterCapitalized = symbolName.slice(0, 1).toUpperCase();

  return '<svg width="50px" height="50px" viewBox="0 0 50 50" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"> <g id="Asset-view" stroke="none" stroke-width="1" fill="none" fill-rule="evenodd"> <g id="Symbols" transform="translate(-367.000000, -248.000000)" fill-rule="nonzero" fill="#000000"> <g id="error" transform="translate(367.000000, 248.000000)"> <path d="M25.016,0.016 C38.8656595,0.016 50.016,11.1663405 50.016,25.016 C50.016,38.8656595 38.8656595,50.016 25.016,50.016 C11.1663405,50.016 0.016,38.8656595 0.016,25.016 C0.016,11.1663405 11.1663405,0.016 25.016,0.016 Z" id="Shape"></path> <text x="50%" y="72%" text-anchor="middle" fill="white" style="font-size: 30px; font-weight: 200;">' + firstLetterCapitalized + '</text> </g> </g> </g> </svg>';
};
